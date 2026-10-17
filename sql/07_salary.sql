-- =====================================================================
-- 07_salary.sql  -  salary PREVIEW (extra feature). Safe to run more than once.
-- Only adds one new table. It does NOT touch attendance, the view, or the month-end Excel.
-- The table is private: only the server (service key) can read it, never the public site.
-- =====================================================================
create table if not exists public.employee_salary (
  employee_id    bigint primary key references public.employees(id) on delete cascade,
  monthly_salary numeric(10,2) not null check (monthly_salary > 0),
  note           text,
  updated_at     timestamptz not null default now()
);
alter table public.employee_salary enable row level security;
revoke all on table public.employee_salary from anon, authenticated;
