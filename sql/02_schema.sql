-- =====================================================================
-- DCC Attendance - Step 2: master data + daily attendance calculation
-- Safe to re-run (idempotent). Needs public.raw_punches from Step 1.
-- =====================================================================

-- ---------- helpers ----------
create or replace function public.norm_name(t text) returns text
language sql immutable as $$
  select lower(regexp_replace(btrim(coalesce(t,'')), '\s+', ' ', 'g'))
$$;

-- ---------- settings (single row; replaces the Settings tab) ----------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  data_start date not null default date '2026-10-01',      -- nothing before this date is calculated
  shift_hours numeric not null default 9,                  -- hours above this = overtime
  late_in_after time not null default time '10:00',
  late_out_from time not null default time '21:00',
  half_day_below numeric not null default 5,               -- worked under this (but >= half_day_min) = Half Day
  half_day_min numeric not null default 1,
  day_cutoff time not null default time '06:00'            -- an Out before this belongs to the previous day (night duty)
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------- locations (fixes GURGAON / Gurgaon / Safdarjung HO casing) ----------
create table if not exists public.location_map (
  form_key text primary key,        -- upper-case value as it comes from the form
  location text not null            -- clean name used everywhere else
);
insert into public.location_map values
  ('GURGAON','Gurgaon'), ('OKHLA','Okhla'), ('SAFDARJUNG HO','Safdarjung HO')
on conflict do nothing;

-- ---------- employees ----------
create table if not exists public.employees (
  id bigint generated always as identity primary key,
  name text not null,
  location text not null,
  active boolean not null default true,
  joined_on date,
  left_on date,                      -- last working day
  in_only boolean not null default false,          -- only an In punch is needed
  no_auto_half_day boolean not null default false, -- field staff: never auto Half Day
  tracked boolean not null default true,           -- false = not on the punch system (no daily rows)
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists employees_name_key on public.employees (public.norm_name(name));

-- every spelling variant that may appear in the form -> one employee
create table if not exists public.employee_aliases (
  alias_key text primary key,        -- norm_name() of the spelling
  employee_id bigint not null references public.employees(id) on delete cascade
);

create or replace function public.employees_add_self_alias() returns trigger
language plpgsql as $$
begin
  insert into public.employee_aliases(alias_key, employee_id)
  values (public.norm_name(new.name), new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists trg_employees_alias on public.employees;
create trigger trg_employees_alias after insert on public.employees
  for each row execute function public.employees_add_self_alias();

-- ---------- holidays ----------
create table if not exists public.holidays (
  holiday_date date primary key,
  name text
);

-- ---------- corrections (manual fixes; raw punches are never edited) ----------
create table if not exists public.corrections (
  id bigint generated always as identity primary key,
  employee_id bigint not null references public.employees(id),
  work_date date not null,
  io text check (io in ('In','Out')),          -- set io + punch_time to add/replace a punch
  punch_time time,
  out_next_day boolean not null default false, -- Out time falls after midnight (night shift)
  status text check (status in ('Present','Absent','Half Day','Extra Day','Holiday')), -- forces the day's status
  night boolean not null default false,        -- night duty confirmed
  source text,                                 -- who/what approved it
  remark text,
  created_at timestamptz not null default now(),
  voided_at timestamptz,                       -- set when replaced/cleared (history is kept)
  check ((io is null) = (punch_time is null)),
  constraint corrections_has_content check (io is not null or status is not null or night or remark is not null)
);
create index if not exists corrections_emp_date on public.corrections (employee_id, work_date);

alter table public.settings         enable row level security;
alter table public.location_map     enable row level security;
alter table public.employees        enable row level security;
alter table public.employee_aliases enable row level security;
alter table public.holidays         enable row level security;
alter table public.corrections      enable row level security;

-- ---------- punches matched to employees, with IST time and work date ----------
create or replace view public.v_punches with (security_invoker = true) as
select
  p.punch_id,
  e.id as employee_id,
  e.name as employee_name,
  coalesce(lm.location, p.location) as location,
  p.io,
  (p.punched_at at time zone 'Asia/Kolkata') as local_ts,
  case when p.io = 'Out'
        and (p.punched_at at time zone 'Asia/Kolkata')::time < s.day_cutoff
       then (p.punched_at at time zone 'Asia/Kolkata')::date - 1
       else (p.punched_at at time zone 'Asia/Kolkata')::date end as work_date,
  p.photo_url,
  p.source
from public.raw_punches p
cross join public.settings s
join public.employee_aliases a on a.alias_key = public.norm_name(p.employee_name_raw)
join public.employees e on e.id = a.employee_id
left join public.location_map lm on lm.form_key = upper(btrim(p.location));

-- punches whose name matches nobody -> fix by adding an employee or an alias
create or replace view public.v_unmatched_punches with (security_invoker = true) as
select p.employee_name_raw, p.location, count(*) as punches,
       min(p.punched_at at time zone 'Asia/Kolkata') as first_seen,
       max(p.punched_at at time zone 'Asia/Kolkata') as last_seen
from public.raw_punches p
left join public.employee_aliases a on a.alias_key = public.norm_name(p.employee_name_raw)
where a.alias_key is null
group by 1,2;

-- ---------- the daily register ----------
create or replace view public.v_daily_attendance with (security_invoker = true) as
with s as (select * from public.settings where id = 1),
days as (
  select d::date as work_date
  from s, generate_series(s.data_start, (now() at time zone 'Asia/Kolkata')::date, interval '1 day') d
),
roster as (
  select e.*, d.work_date
  from public.employees e
  join days d on d.work_date >= coalesce(e.joined_on, date '1900-01-01')
             and (e.left_on is null or d.work_date <= e.left_on)
  where e.tracked and (e.active or e.left_on is not null)
),
pun as (
  select employee_id, work_date,
         min(local_ts) filter (where io = 'In')  as first_in,
         max(local_ts) filter (where io = 'Out') as last_out,
         count(*) filter (where io = 'In')  as n_in,
         count(*) filter (where io = 'Out') as n_out
  from public.v_punches group by 1,2
),
corr_punch as (   -- latest manual In/Out per day
  select distinct on (employee_id, work_date, io)
         employee_id, work_date, io, punch_time, out_next_day
  from public.corrections where io is not null and voided_at is null
  order by employee_id, work_date, io, created_at desc
),
corr_in  as (select employee_id, work_date, work_date + punch_time as ts from corr_punch where io = 'In'),
corr_out as (select employee_id, work_date, work_date + punch_time + case when out_next_day then interval '1 day' else interval '0' end as ts from corr_punch where io = 'Out'),
corr_flags as (
  select employee_id, work_date,
         (array_agg(status order by created_at desc) filter (where status is not null))[1] as status,
         bool_or(night) as night,
         string_agg(distinct nullif(concat_ws(' | ', source, remark), ''), ' ; ') as note
  from public.corrections where voided_at is null group by 1,2
),
calc as (
  select r.id as employee_id, r.name as employee, r.location, r.work_date,
         r.in_only, r.no_auto_half_day,
         coalesce(ci.ts, p.first_in)  as in_ts,
         coalesce(co.ts, p.last_out)  as out_ts,
         coalesce(p.n_in,0) as n_in, coalesce(p.n_out,0) as n_out,
         cf.status as corr_status, coalesce(cf.night,false) as night, cf.note,
         (extract(dow from r.work_date) = 0) as is_sunday,
         exists (select 1 from public.holidays h where h.holiday_date = r.work_date) as is_holiday,
         (ci.ts is not null or co.ts is not null or cf.status is not null) as corrected
  from roster r
  left join pun p        on p.employee_id = r.id and p.work_date = r.work_date
  left join corr_in ci   on ci.employee_id = r.id and ci.work_date = r.work_date
  left join corr_out co  on co.employee_id = r.id and co.work_date = r.work_date
  left join corr_flags cf on cf.employee_id = r.id and cf.work_date = r.work_date
),
hrs as (
  select c.*,
    case when in_ts is not null and out_ts is not null and out_ts > in_ts
         then round((extract(epoch from out_ts - in_ts) / 3600)::numeric, 2) end as hours
  from calc c
),
st as (
  select h.*,
    (h.corr_status is null and (h.in_ts is not null or h.out_ts is not null)
      and not (h.is_sunday or h.is_holiday) and not h.in_only and not h.no_auto_half_day
      and coalesce(h.hours >= s.half_day_min and h.hours < s.half_day_below, false)) as auto_half
  from hrs h cross join s
)
select
  h.work_date, to_char(h.work_date, 'Dy') as day, h.employee_id, h.employee, h.location,
  h.in_ts::time(0) as in_time, h.out_ts::time(0) as out_time, h.hours,
  case
    when h.corr_status is not null then h.corr_status
    when h.in_ts is not null or h.out_ts is not null then
      case when h.is_sunday or h.is_holiday then 'Extra Day'
           when h.in_only then (case when h.in_ts is not null then 'Present' else 'Missing Punch' end)
           when h.work_date = (now() at time zone 'Asia/Kolkata')::date and h.out_ts is null then 'In Progress'
           when h.hours is null or h.hours < s.half_day_min then 'Missing Punch'
           when h.auto_half then 'Half Day'
           else 'Present' end
    when h.is_holiday then 'Holiday'
    when h.is_sunday then 'Sunday'
    else 'Absent' end as status,
  case when h.hours > s.shift_hours then round(h.hours - s.shift_hours, 2) else 0 end as ot_hours,
  -- minute precision (10:00:40 is not late); a part-day auto Half Day is not "late"
  (h.in_ts is not null and not h.auto_half
     and date_trunc('minute', h.in_ts) > h.work_date + s.late_in_after) as late_in,
  (h.out_ts is not null and h.out_ts >= h.work_date + s.late_out_from) as late_out,
  h.night,
  h.n_in, h.n_out,
  case when h.in_ts is not null and h.out_ts is not null and h.out_ts <= h.in_ts then 'Out before In (labels reversed?)'
       when h.n_in > 1 or h.n_out > 1 then 'Duplicate punches'
       end as flag,
  case when h.corrected then 'Corrected' when h.n_in + h.n_out > 0 then 'System punch' end as source,
  h.note
from st h cross join s;

-- ---------- month summary per employee ----------
create or replace view public.v_monthly_summary with (security_invoker = true) as
select date_trunc('month', work_date)::date as month, employee_id, employee, location,
  count(*) filter (where status = 'Present')       as present_days,
  count(*) filter (where status = 'Half Day')      as half_days,
  count(*) filter (where status = 'Extra Day')     as extra_days,
  count(*) filter (where status = 'Absent')        as absent_days,
  count(*) filter (where status = 'Sunday')        as sundays,
  count(*) filter (where status = 'Holiday')       as holidays,
  count(*) filter (where status = 'Missing Punch') as missing_punch_days,
  count(*) filter (where late_in)                  as late_ins,
  count(*) filter (where late_out)                 as late_outs,
  count(*) filter (where night)                    as nights,
  coalesce(sum(ot_hours),0)                        as ot_hours
from public.v_daily_attendance
group by 1,2,3,4;
