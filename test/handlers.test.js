'use strict';
const test = require('node:test'), assert = require('node:assert');
const { makeAuth } = require('../lib/auth');
const { createHandlers } = require('../lib/handlers');
const { fakeDb, ENV } = require('./helpers');

const NOW = () => new Date('2026-10-15T08:00:00Z'); // 13:30 IST
function setup(routes, env) {
  const db = fakeDb(Object.assign({ 'settings?': [{ data_start: '2026-10-01' }] }, routes));
  const e = Object.assign({}, ENV, env || {});
  const auth = makeAuth(e, NOW);
  return { db, auth, h: createHandlers({ env: e, db, auth, drive: {}, exporter: {}, now: NOW }) };
}

test('admin login: lockout, wrong PIN, success', async () => {
  const s = setup({ 'rpc/admin_attempt_allowed': false });
  await assert.rejects(s.h.webAdminLogin({}, 'secret-pin'), /Too many wrong attempts/);
  const s2 = setup({ 'rpc/admin_attempt_allowed': true });
  await assert.rejects(s2.h.webAdminLogin({}, 'bad'), /Wrong PIN/);
  const r = await s2.h.webAdminLogin({}, 'secret-pin');
  s2.auth.needAdmin(r.token);
  assert.ok(s2.db.calls.some((c) => c.rpc === 'admin_attempt_log' && c.args.p_ok === true));
});

test('admin functions refuse without a token', async () => {
  const s = setup({});
  await assert.rejects(s.h.webAdminSetDay({}, 'nope', { employee_id: 1, date: '2026-10-10', status: 'Present' }), /AUTH_EXPIRED/);
  await assert.rejects(s.h.webAdminAddEmployee({}, '', {}), /AUTH_EXPIRED/);
  await assert.rejects(s.h.webAdminExportMonth({}, '', '2026-10'), /AUTH_EXPIRED/);
});

test('admin set day: validation and rpc call', async () => {
  const s = setup({ 'rpc/admin_set_day': 1 });
  const tok = s.auth.makeAdminToken();
  await assert.rejects(s.h.webAdminSetDay({}, tok, { employee_id: 1, date: '2026-10-20', status: 'Present' }), /future/);
  await assert.rejects(s.h.webAdminSetDay({}, tok, { employee_id: 1, date: '2026-09-20', status: 'Present' }), /data start/);
  await assert.rejects(s.h.webAdminSetDay({}, tok, { employee_id: 1, date: '2026-10-10', in: '9:5' }), /HH:MM/);
  await assert.rejects(s.h.webAdminSetDay({}, tok, { employee_id: 1, date: '2026-10-10', status: 'Weird' }), /Unknown status/);
  await assert.rejects(s.h.webAdminSetDay({}, tok, { employee_id: 1, date: '2026-10-10' }), /Nothing to save/);
  const r = await s.h.webAdminSetDay({}, tok, { employee_id: '7', date: '2026-10-10', in: '09:05', out: '18:10', status: 'Present' });
  assert.equal(r.ok, true);
  const c = s.db.calls.find((x) => x.rpc === 'admin_set_day');
  assert.equal(c.args.p_employee, 7); assert.equal(c.args.p_in, '09:05');
});

test('range: clamps to data start / today and caps at 3 months', async () => {
  const s = setup({ 'v_daily_attendance?': [{ employee_id: 1, work_date: '2026-10-02', status: 'Present', in_time: '09:00:00', out_time: '18:00:00', hours: 9, ot_hours: 0, late_in: false, late_out: true, night: false }] });
  const r = await s.h.webRange({}, '2026-01-01', '2026-12-31');
  assert.equal(r.from, '2026-10-01'); assert.equal(r.to, '2026-10-15');
  assert.deepStrictEqual(r.rows[0].slice(0, 3), [1, '2026-10-02', 'Present']);
  assert.equal(r.rows[0][8], 1);
  await assert.rejects(s.h.webRange({}, 'x', 'y'), /Bad request/);
});

test('branch login: only branches with a PIN, logs, token scopes to branch', async () => {
  const s = setup({
    'employees?select=location': [{ location: 'Okhla' }, { location: 'Okhla' }, { location: 'Gurgaon' }],
    'rpc/admin_attempt_allowed': true,
  });
  assert.deepStrictEqual(await s.h.webBranchList(), [{ location: 'Okhla', staff: 2 }]);
  await assert.rejects(s.h.webBranchLogin({ ip: '1.2.3.4' }, 'Gurgaon', '1234', 'Amit', ''), /not set up/);
  await assert.rejects(s.h.webBranchLogin({ ip: '1.2.3.4' }, 'Okhla', '0000', 'Amit', ''), /Wrong PIN/);
  await assert.rejects(s.h.webBranchLogin({}, 'Okhla', '1234', 'A', ''), /type your name/);
  const r = await s.h.webBranchLogin({ ip: '1.2.3.4' }, 'Okhla', '1234', 'Amit', 'Chrome');
  assert.equal(s.auth.needBranch(r.token).l, 'Okhla');
  const ev = s.db.calls.filter((c) => c.rpc === 'branch_log_event');
  assert.ok(ev.some((c) => c.args.p_action === 'login_ok' && /ip 1\.2\.3\.4/.test(c.args.p_client)));
  assert.ok(ev.some((c) => c.args.p_action === 'login_fail'));
  // set uses the branch from the TOKEN, never from the request
  s.db.calls.length = 0;
  await s.h.webBranchSet({ ip: '9.9.9.9' }, r.token, { employee_id: 5, date: '2026-10-14', extra: true, branch: 'Gurgaon' });
  const c = s.db.calls.find((x) => x.rpc === 'branch_set_day');
  assert.equal(c.args.p_branch, 'Okhla'); assert.equal(c.args.p_actor, 'Amit'); assert.equal(c.args.p_extra, true);
});

test('branch login is blocked after too many attempts', async () => {
  const s = setup({ 'employees?select=location': [{ location: 'Okhla' }], 'rpc/admin_attempt_allowed': false });
  await assert.rejects(s.h.webBranchLogin({}, 'Okhla', '1234', 'Amit', ''), /Too many/);
});

test('add employee: rules', async () => {
  const s = setup({ 'employees?select=id,name,location,active': [{ id: 1, name: 'Ravi Kumar', location: 'Okhla', active: true }, { id: 2, name: 'Old Guy', location: 'Okhla', active: false }] });
  const tok = s.auth.makeAdminToken();
  await assert.rejects(s.h.webAdminAddEmployee({}, tok, { name: 'R2D2', location: 'Okhla' }), /letters only/);
  await assert.rejects(s.h.webAdminAddEmployee({}, tok, { name: 'New Guy', location: 'Mars' }), /location/);
  await assert.rejects(s.h.webAdminAddEmployee({}, tok, { name: 'ravi  kumar', location: 'Okhla' }), /already exists/);
  const r1 = await s.h.webAdminAddEmployee({}, tok, { name: 'Old Guy', location: 'Okhla' });
  assert.equal(r1.restored, true);
  const r2 = await s.h.webAdminAddEmployee({}, tok, { name: 'New Guy', location: 'Okhla' });
  assert.equal(r2.restored, false);
  assert.ok(s.db.calls.some((c) => c.method === 'post' && c.path === 'employees'));
});

test('photo: id format checked and must belong to a real punch', async () => {
  const s = setup({ 'raw_punches?': [] });
  await assert.rejects(s.h.webPhoto({}, '../../etc'), /Bad request/);
  await assert.rejects(s.h.webPhoto({}, 'abcdefghijklmnopqrstu'), /Photo not found/);
});

test('photo proxy: used when configured, errors are readable', async () => {
  const { makeDrive } = require('../lib/drive');
  const env = { PHOTO_PROXY_URL: 'https://script.google.com/macros/s/AAA/exec', PHOTO_PROXY_SECRET: 'x'.repeat(24) };
  let seen = '';
  const ok = makeDrive(env, async (u) => { seen = u; return { json: async () => ({ m: 'image/jpeg', b: 'QUJD' }) }; });
  assert.deepStrictEqual(await ok.photo('abcdefghijklmnopqrstu'), { m: 'image/jpeg', b: 'QUJD' });
  assert.match(seen, /id=abcdefghijklmnopqrstu&s=x{24}$/);
  const bad = makeDrive(env, async () => ({ json: async () => ({ error: 'forbidden' }) }));
  await assert.rejects(bad.photo('abcdefghijklmnopqrstu'), /secret does not match/);
  const none = makeDrive({}, async () => ({}));
  await assert.rejects(none.photo('abcdefghijklmnopqrstu'), /not set up/);
});
