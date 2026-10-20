-- =====================================================================
-- DCC Attendance - Step 6: BRANCH PORTAL (extra days + night duty entered by Okhla / Gurgaon / Safdarjung)
-- Safe to re-run. Apply AFTER 05_fix_open_shift_late_in.sql. Run the whole file in Supabase > SQL Editor.
-- =====================================================================

-- ---------- what the branches enter (one row per employee per day) ----------
create table if not exists public.branch_entries (
  employee_id    bigint not null references public.employees(id),
  work_date      date   not null,
  extra_day      boolean not null default false,
  night          boolean not null default false,
  remark         text,
  entered_branch text   not null,       -- branch whose PIN was used
  entered_by     text   not null,       -- name typed at login + Google account
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (employee_id, work_date),
  constraint branch_entries_has_content check (extra_day or night)
);
create index if not exists branch_entries_date on public.branch_entries (work_date);

-- ---------- full audit log: logins, failed logins, every change ----------
create table if not exists public.branch_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  branch        text not null,
  actor         text,                   -- "Name (google email)"
  action        text not null check (action in ('login_ok','login_fail','logout','set','clear')),
  employee_id   bigint,
  employee_name text,
  work_date     date,
  old_extra     boolean,
  old_night     boolean,
  new_extra     boolean,
  new_night     boolean,
  remark        text,
  no_punch      boolean,                -- entry was made for a day with no punch at all
  client        text,                   -- browser / device
  detail        text
);
create index if not exists branch_log_at on public.branch_log (at desc);
create index if not exists branch_log_branch_at on public.branch_log (branch, at desc);

alter table public.branch_entries enable row level security;
alter table public.branch_log     enable row level security;
revoke all on table public.branch_entries from anon, authenticated;
revoke all on table public.branch_log     from anon, authenticated;

-- ---------- the daily register, now including branch entries ----------
-- Same columns as before + 6 at the end. Admin corrections still win; a branch "night" adds to admin night.
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
corr_punch as (
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
         cf.status as corr_status,
         (coalesce(cf.night,false) or coalesce(be.night,false)) as night,
         nullif(concat_ws(' ; ', cf.note, case when be.employee_id is not null
                then 'Branch: ' || concat_ws(' - ', be.entered_branch, nullif(be.remark,'')) end), '') as note,
         (extract(dow from r.work_date) = 0) as is_sunday,
         exists (select 1 from public.holidays h where h.holiday_date = r.work_date) as is_holiday,
         (ci.ts is not null or co.ts is not null or cf.status is not null) as corrected,
         coalesce(be.extra_day,false) as b_extra,
         coalesce(be.night,false)     as b_night,
         (be.employee_id is not null) as b_has,
         be.entered_by                as b_by,
         be.remark                    as b_remark,
         be.updated_at                as b_at
  from roster r
  left join pun p        on p.employee_id = r.id and p.work_date = r.work_date
  left join corr_in ci   on ci.employee_id = r.id and ci.work_date = r.work_date
  left join corr_out co  on co.employee_id = r.id and co.work_date = r.work_date
  left join corr_flags cf on cf.employee_id = r.id and cf.work_date = r.work_date
  left join public.branch_entries be on be.employee_id = r.id and be.work_date = r.work_date
),
hrs as (
  select c.*,
    case when in_ts is not null and out_ts is not null and out_ts > in_ts
         then round((extract(epoch from out_ts - in_ts) / 3600)::numeric, 2) end as hours
  from calc c
),
st as (
  select h.*,
    (h.corr_status is null and not h.b_extra and (h.in_ts is not null or h.out_ts is not null)
      and not (h.is_sunday or h.is_holiday) and not h.in_only and not h.no_auto_half_day
      and coalesce(h.hours >= s.half_day_min and h.hours < s.half_day_below, false)) as auto_half
  from hrs h cross join s
)
select
  h.work_date, to_char(h.work_date, 'Dy') as day, h.employee_id, h.employee, h.location,
  h.in_ts::time(0) as in_time, h.out_ts::time(0) as out_time, h.hours,
  case
    when h.corr_status is not null then h.corr_status
    when h.b_extra then 'Extra Day'
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
  (h.in_ts is not null and not h.auto_half
     and date_trunc('minute', h.in_ts) > h.work_date + s.late_in_after) as late_in,
  (h.out_ts is not null and h.out_ts >= h.work_date + s.late_out_from) as late_out,
  h.night,
  h.n_in, h.n_out,
  case when h.in_ts is not null and h.out_ts is not null and h.out_ts <= h.in_ts then 'Out before In (labels reversed?)'
       when h.n_in > 1 or h.n_out > 1 then 'Duplicate punches'
       when h.b_has and h.n_in + h.n_out = 0 and not h.corrected then 'Branch entry without punch'
       end as flag,
  case when h.corrected then 'Corrected'
       when h.b_has then 'Branch'
       when h.n_in + h.n_out > 0 then 'System punch' end as source,
  h.note,
  h.b_extra as branch_extra, h.b_night as branch_night, h.b_has as branch_entry, h.b_by as branch_by,
  h.b_remark as branch_remark, h.b_at as branch_at
from st h cross join s;

-- ---------- log a login / failed login / logout ----------
create or replace function public.branch_log_event(
  p_branch text, p_actor text, p_action text, p_client text, p_detail text
) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_action not in ('login_ok','login_fail','logout') then raise exception 'bad action'; end if;
  insert into public.branch_log(branch, actor, action, client, detail)
  values (left(coalesce(p_branch,'?'),60), left(p_actor,160), p_action, left(p_client,300), left(p_detail,300));
end $$;

-- ---------- set / clear one employee-day (all rules enforced here, logged here) ----------
create or replace function public.branch_set_day(
  p_branch text, p_employee bigint, p_date date,
  p_extra boolean, p_night boolean, p_remark text,
  p_actor text, p_client text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  e record; s record; o record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_has_old boolean; v_nopunch boolean;
  v_extra boolean := coalesce(p_extra,false);
  v_night boolean := coalesce(p_night,false);
  v_remark text := left(nullif(btrim(coalesce(p_remark,'')),''), 300);
begin
  select * into s from public.settings where id = 1;
  select * into e from public.employees where id = p_employee;
  if not found or not e.tracked then raise exception 'Employee not found'; end if;
  if lower(btrim(e.location)) <> lower(btrim(coalesce(p_branch,''))) then raise exception 'This employee is not in your branch'; end if;
  if p_date is null or p_date > v_today then raise exception 'You cannot edit a future date'; end if;
  if date_trunc('month', p_date) <> date_trunc('month', v_today) then raise exception 'Only the current month can be edited'; end if;
  if p_date < s.data_start then raise exception 'Date is before the data start'; end if;
  if p_date < coalesce(e.joined_on, date '1900-01-01') or (e.left_on is not null and p_date > e.left_on) then
    raise exception 'Employee was not working on that date';
  end if;

  select * into o from public.branch_entries where employee_id = p_employee and work_date = p_date;
  v_has_old := found;
  v_nopunch := not exists (select 1 from public.v_punches where employee_id = p_employee and work_date = p_date);

  if not v_extra and not v_night then
    if not v_has_old then return jsonb_build_object('ok', true, 'changed', false, 'extra', false, 'night', false); end if;
    delete from public.branch_entries where employee_id = p_employee and work_date = p_date;
    insert into public.branch_log(branch, actor, action, employee_id, employee_name, work_date,
                                  old_extra, old_night, new_extra, new_night, remark, no_punch, client)
    values (e.location, left(p_actor,160), 'clear', e.id, e.name, p_date,
            o.extra_day, o.night, false, false, o.remark, v_nopunch, left(p_client,300));
    return jsonb_build_object('ok', true, 'changed', true, 'extra', false, 'night', false, 'no_punch', v_nopunch);
  end if;

  if v_has_old and o.extra_day = v_extra and o.night = v_night and o.remark is not distinct from v_remark then
    return jsonb_build_object('ok', true, 'changed', false, 'extra', v_extra, 'night', v_night, 'no_punch', v_nopunch);
  end if;

  insert into public.branch_entries(employee_id, work_date, extra_day, night, remark, entered_branch, entered_by)
  values (p_employee, p_date, v_extra, v_night, v_remark, e.location, left(p_actor,160))
  on conflict (employee_id, work_date) do update
    set extra_day = excluded.extra_day, night = excluded.night, remark = excluded.remark,
        entered_branch = excluded.entered_branch, entered_by = excluded.entered_by, updated_at = now();

  insert into public.branch_log(branch, actor, action, employee_id, employee_name, work_date,
                                old_extra, old_night, new_extra, new_night, remark, no_punch, client)
  values (e.location, left(p_actor,160), 'set', e.id, e.name, p_date,
          case when v_has_old then o.extra_day else false end, case when v_has_old then o.night else false end,
          v_extra, v_night, v_remark, v_nopunch, left(p_client,300));

  return jsonb_build_object('ok', true, 'changed', true, 'extra', v_extra, 'night', v_night, 'no_punch', v_nopunch);
end $$;

-- ---------- only the secret (service_role) key may call these ----------
revoke all on function public.branch_log_event(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.branch_set_day(text,bigint,date,boolean,boolean,text,text,text) from public, anon, authenticated;
grant execute on function public.branch_log_event(text,text,text,text,text) to service_role;
grant execute on function public.branch_set_day(text,bigint,date,boolean,boolean,text,text,text) to service_role;
