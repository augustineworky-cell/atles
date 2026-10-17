'use strict';
const test = require('node:test'), assert = require('node:assert');
const { calcEmployee, buildMonth } = require('../lib/salary');
const { makeAuth } = require('../lib/auth');
const { createHandlers } = require('../lib/handlers');
const { fakeDb, ENV } = require('./helpers');

// October 2026: 1 Thu ... 4 Sun, 11 Sun, 18 Sun, 25 Sun. 31 days.
const mk = (map) => Object.keys(map).map((d) => ({ work_date: d, status: map[d] }));
const oct = (n) => '2026-10-' + String(n).padStart(2, '0');
function month(fill) { const m = {}; for (let d = 1; d <= 31; d++) m[oct(d)] = [4, 11, 18, 25].includes(d) ? 'Sunday' : (fill || 'Present'); return m; }

test('full month present, Sundays paid: pays the whole salary', () => {
  const r = calcEmployee(31000, mk(month()), '2026-10');
  assert.equal(r.paid_days, 31); assert.equal(r.total, 31000); assert.equal(r.sunday_paid, 4);
});

test('absent = no pay, half day = half pay', () => {
  const m = month(); m[oct(6)] = 'Absent'; m[oct(7)] = 'Half Day';
  const r = calcEmployee(31000, mk(m), '2026-10');
  assert.equal(r.strip.length, 31); assert.equal(r.strip[5], 'A'); assert.equal(r.strip[6], 'H'); assert.equal(r.strip[3], 'S');
  assert.equal(r.paid_days, 29.5); assert.equal(r.total, 29500);
});

test('Sunday between two Absent working days is not paid (long leave)', () => {
  const m = month(); m[oct(9)] = 'Absent'; m[oct(10)] = 'Absent'; m[oct(12)] = 'Absent';   // Fri,Sat absent | Sun 11 | Mon absent
  const r = calcEmployee(31000, mk(m), '2026-10');
  assert.equal(r.sunday_unpaid, 1); assert.deepEqual(r.unpaid_sundays, [oct(11)]);
  assert.equal(r.paid_days, 31 - 3 - 1);
});

test('Sunday after a single absence is still paid (Present on the other side)', () => {
  const m = month(); m[oct(10)] = 'Absent';
  const r = calcEmployee(31000, mk(m), '2026-10');
  assert.equal(r.sunday_unpaid, 0); assert.equal(r.paid_days, 30);
});

test('Extra Day (worked Sunday) pays that day plus one extra day', () => {
  const m = month(); m[oct(11)] = 'Extra Day';
  const r = calcEmployee(31000, mk(m), '2026-10');
  assert.equal(r.extra, 1); assert.equal(r.paid_days, 31);
  assert.equal(r.base_pay, 31000); assert.equal(r.extra_pay, 1000); assert.equal(r.total, 32000);
});

test('joined mid-month: only days since joining are paid; missing punch paid as a full day', () => {
  const m = {}; for (let d = 6; d <= 10; d++) m[oct(d)] = 'Present'; m[oct(11)] = 'Sunday'; m[oct(12)] = 'Missing Punch';
  const r = calcEmployee(31000, mk(m), '2026-10');
  assert.equal(r.paid_days, 7); assert.equal(r.total, 7000); assert.equal(r.missing, 1);
});

test('buildMonth: people with attendance but no salary are listed, not paid', () => {
  const rows = [];
  [1, 2].forEach((id) => { for (let d = 1; d <= 3; d++) rows.push({ employee_id: id, work_date: oct(d), status: 'Present' }); });
  const out = buildMonth({ month: '2026-10', emps: [{ id: 1, name: 'A', location: 'X' }, { id: 2, name: 'B', location: 'X' }], salaries: [{ employee_id: 1, monthly_salary: 31000 }], rows });
  assert.equal(out.people, 1); assert.equal(out.total, 3000); assert.deepEqual(out.no_salary.map((e) => e.name), ['B']);
});

const NOW = () => new Date('2026-10-15T08:00:00Z');
function setup(routes) {
  const db = fakeDb(Object.assign({ 'settings?': [{ data_start: '2026-10-01' }] }, routes));
  const auth = makeAuth(ENV, NOW);
  return { db, auth, h: createHandlers({ env: ENV, db, auth, drive: {}, exporter: {}, now: NOW }) };
}
test('salary handler: admin only, tells you when the table is not set up, never touches the exporter', async () => {
  const s = setup({});
  await assert.rejects(s.h.webAdminSalaryMonth({}, '', '2026-10'), /AUTH_EXPIRED/);
  const tok = s.auth.makeAdminToken();
  await assert.rejects(s.h.webAdminSalaryMonth({}, tok, 'bad'), /Bad request/);
  const s2 = setup({ 'employee_salary?': () => { throw new Error('relation does not exist'); } });
  const r = await s2.h.webAdminSalaryMonth({}, s2.auth.makeAdminToken(), '2026-10');
  assert.equal(r.setup_needed, true);
  const s3 = setup({
    'employee_salary?': [{ employee_id: 5, monthly_salary: 31000 }],
    'employees?': [{ id: 5, name: 'Sam', location: 'Okhla', active: true }],
    'v_daily_attendance?': [{ employee_id: 5, work_date: '2026-10-01', status: 'Present' }, { employee_id: 5, work_date: '2026-10-02', status: 'Absent' }],
  });
  const ok = await s3.h.webAdminSalaryMonth({}, s3.auth.makeAdminToken(), '2026-10');
  assert.equal(ok.rows[0].total, 1000); assert.equal(ok.people, 1);
});
