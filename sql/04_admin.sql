-- =====================================================================
-- DCC Attendance - Step 3: admin editing support (PIN-protected dashboard)
-- Safe to re-run. Apply AFTER 02_schema.sql.
-- =====================================================================

-- corrections: next-day Out, soft delete, remark-only notes
alter table public.corrections add column if not exists out_next_day boolean not null default false;
alter table public.corrections add column if not exists voided_at timestamptz;
do $$ declare c text; begin
  for c in select conname from pg_constraint
           where conrelid = 'public.corrections'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%night%'
  loop execute format('alter table public.corrections drop constraint %I', c); end loop;
end $$;
alter table public.corrections add constraint corrections_has_content
  check (io is not null or status is not null or night or remark is not null);

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


-- ---------- admin PIN attempt log (brute-force lockout) ----------
create table if not exists public.admin_attempts (
  id bigint generated always as identity primary key,
  attempt_key text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists admin_attempts_key_at on public.admin_attempts (attempt_key, at desc);
alter table public.admin_attempts enable row level security;

create or replace function public.admin_attempt_allowed(p_key text) returns boolean
language sql security invoker set search_path = '' as $$
  select
    (select count(*) from public.admin_attempts
       where attempt_key = p_key and not ok and at > now() - interval '15 minutes') < 5
    and
    (select count(*) from public.admin_attempts
       where not ok and at > now() - interval '15 minutes') < 30
$$;

create or replace function public.admin_attempt_log(p_key text, p_ok boolean) returns void
language sql security invoker set search_path = '' as $$
  insert into public.admin_attempts(attempt_key, ok) values (p_key, p_ok);
  delete from public.admin_attempts where at < now() - interval '2 days';
$$;

-- ---------- replace everything admin set for one employee-day ----------
create or replace function public.admin_set_day(
  p_employee bigint, p_date date,
  p_in time, p_out time, p_out_next_day boolean,
  p_status text, p_night boolean, p_source text, p_remark text
) returns int
language plpgsql security invoker set search_path = '' as $$
declare n int := 0;
begin
  if p_date < (select data_start from public.settings where id = 1) then
    raise exception 'date before data_start';
  end if;
  update public.corrections set voided_at = now()
   where employee_id = p_employee and work_date = p_date and voided_at is null;
  if p_in is not null then
    insert into public.corrections(employee_id, work_date, io, punch_time, source, remark)
    values (p_employee, p_date, 'In', p_in, p_source, p_remark); n := n + 1;
  end if;
  if p_out is not null then
    insert into public.corrections(employee_id, work_date, io, punch_time, out_next_day, source, remark)
    values (p_employee, p_date, 'Out', p_out, coalesce(p_out_next_day,false), p_source, p_remark); n := n + 1;
  end if;
  if p_status is not null or coalesce(p_night,false) or (p_in is null and p_out is null and nullif(p_remark,'') is not null) then
    insert into public.corrections(employee_id, work_date, status, night, source, remark)
    values (p_employee, p_date, nullif(p_status,''), coalesce(p_night,false), p_source, nullif(p_remark,'')); n := n + 1;
  end if;
  return n;
end $$;

create or replace function public.admin_clear_day(p_employee bigint, p_date date) returns int
language sql security invoker set search_path = '' as $$
  with u as (
    update public.corrections set voided_at = now()
     where employee_id = p_employee and work_date = p_date and voided_at is null
    returning 1)
  select count(*)::int from u
$$;

-- only the secret (service_role) key may call these; never the public API keys
revoke all on function public.admin_attempt_allowed(text) from public, anon, authenticated;
revoke all on function public.admin_attempt_log(text, boolean) from public, anon, authenticated;
revoke all on function public.admin_set_day(bigint,date,time,time,boolean,text,boolean,text,text) from public, anon, authenticated;
revoke all on function public.admin_clear_day(bigint,date) from public, anon, authenticated;
grant execute on function public.admin_attempt_allowed(text) to service_role;
grant execute on function public.admin_attempt_log(text, boolean) to service_role;
grant execute on function public.admin_set_day(bigint,date,time,time,boolean,text,boolean,text,text) to service_role;
grant execute on function public.admin_clear_day(bigint,date) to service_role;
