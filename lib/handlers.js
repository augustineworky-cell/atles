'use strict';
/**
 * Every dashboard function (ported 1:1 from the old Apps Script WebApp.gs).
 * Each handler is  (ctx, ...args) => result   where ctx = { ip }.
 * Functions listed in PUBLIC need nothing; admin functions take the admin token as first argument;
 * branch functions take the branch token. Anything not exported here cannot be called from the browser.
 */
const salary = require('./salary');
const { AppError, fail, isInt, isDate, isMonth, isTime, istDate, addDay, daysBetween, norm } = require('./util');

const STATUSES = ['Present', 'Absent', 'Half Day', 'Extra Day', 'Holiday'];
const DAY_COLS = 'employee_id,work_date,status,in_time,out_time,hours,ot_hours,late_in,late_out,night,source,note';

function createHandlers({ env, db, auth, drive, exporter, now }) {
  const clock = now || (() => new Date());
  const today = () => istDate(clock());
  const clientTag = (ctx, c) => (String(c || '').slice(0, 260) + (ctx && ctx.ip ? ' | ip ' + ctx.ip : '')).slice(0, 300);

  async function dataStart() {
    const r = await db.rest('settings?select=data_start&id=eq.1', 'get');
    return r && r[0] ? r[0].data_start : '2026-10-01';
  }

  /* ---------------- site gate ---------------- */
  async function siteLogin(ctx, pw) {
    if (!auth.siteLocked()) return { token: '' };
    if (!auth.checkSitePassword(pw)) { await new Promise((r) => setTimeout(r, 400)); fail('Wrong password'); }
    return { token: auth.makeSiteToken() };
  }

  /* ---------------- public (view only) ---------------- */
  async function webEmployees() {
    const [emps, latest, ds] = await Promise.all([
      db.rest('employees?select=id,name,location,active,left_on&tracked=eq.true&order=name.asc&limit=1000', 'get'),
      db.rest('raw_punches?select=punched_at&order=punched_at.desc&limit=1', 'get'),
      dataStart(),
    ]);
    return { employees: emps, today: today(), data_start: ds, latest_punch: latest && latest[0] ? latest[0].punched_at : null };
  }

  async function webRange(ctx, from, to) {
    if (!isDate(from) || !isDate(to)) fail('Bad request');
    const t = today(), ds = await dataStart();
    if (from < ds) from = ds;
    if (to > t) to = t;
    if (from > to) return { from, to, today: t, rows: [] };
    if (daysBetween(from, to) > 95) fail('Pick a range of up to 3 months');
    const out = await db.all('v_daily_attendance?select=' + DAY_COLS + '&work_date=gte.' + from + '&work_date=lte.' + to + '&order=work_date.asc,employee_id.asc', 31000);
    return { from, to, today: t, rows: out.map((r) => [r.employee_id, r.work_date, r.status, r.in_time, r.out_time, r.hours, r.ot_hours,
      r.late_in ? 1 : 0, r.late_out ? 1 : 0, r.night ? 1 : 0, r.source || '', r.note || '']) };
  }

  async function webCalendar(ctx, employeeId, month) {
    if (!isInt(employeeId) || !isMonth(month)) fail('Bad request');
    const y = +month.slice(0, 4), m = +month.slice(5);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const t = today(), ds = await dataStart();
    let from = month + '-01', to = month + '-' + ('0' + last).slice(-2);
    if (from < ds) from = ds;
    if (to > t) to = t;
    const emp = await db.rest('employees?select=id,name,location,active,joined_on,left_on&id=eq.' + employeeId + '&tracked=eq.true&limit=1', 'get');
    if (!emp.length) fail('Employee not found');
    let rows = [];
    if (from <= to) {
      rows = await db.rest('v_daily_attendance?select=work_date,day,status,in_time,out_time,hours,ot_hours,late_in,late_out,night,flag,source,note,n_in,n_out,branch_extra,branch_night,branch_entry,branch_by,branch_remark,branch_at'
        + '&employee_id=eq.' + employeeId + '&work_date=gte.' + from + '&work_date=lte.' + to + '&order=work_date.asc&limit=40', 'get');
    }
    return { employee: emp[0], month, from, to, today: t, rows };
  }

  async function webDayPunches(ctx, employeeId, date) {
    if (!isInt(employeeId) || !isDate(date)) fail('Bad request');
    if (date < await dataStart() || date > today()) fail('Bad request');
    return { punches: await db.rest('v_punches?select=local_ts,io,location,photo_url&employee_id=eq.' + employeeId + '&work_date=eq.' + date + '&order=local_ts.asc&limit=50', 'get') };
  }

  /** A punch photo as base64. Only files that are real punch photos in Supabase can be requested. */
  async function webPhoto(ctx, fileId) {
    fileId = String(fileId || '');
    if (!/^[\w-]{15,80}$/.test(fileId)) fail('Bad request');
    const ok = await db.rest('raw_punches?select=punch_id&photo_url=like.*' + fileId + '*&limit=1', 'get');
    if (!ok || !ok.length) fail('Photo not found');
    return drive.photo(fileId);
  }

  /* ---------------- admin ---------------- */
  async function webAdminLogin(ctx, pin) {
    auth.secret();
    const KEY = 'web';
    if (!(await db.rpc('admin_attempt_allowed', { p_key: KEY }))) fail('Too many wrong attempts. Try again in 15 minutes.');
    const ok = auth.checkAdminPin(pin);
    await db.rpc('admin_attempt_log', { p_key: KEY, p_ok: ok });
    if (!ok) fail('Wrong PIN');
    return { token: auth.makeAdminToken(), seconds_left: auth.TTL_ADMIN };
  }

  async function webAdminPunches(ctx, token, employeeId, date) {
    auth.needAdmin(token);
    if (!isInt(employeeId) || !isDate(date)) fail('Bad request');
    const [punches, corrections] = await Promise.all([
      db.rest('v_punches?select=local_ts,io,location,photo_url&employee_id=eq.' + employeeId + '&work_date=eq.' + date + '&order=local_ts.asc&limit=50', 'get'),
      db.rest('corrections?select=io,punch_time,out_next_day,status,night,source,remark,created_at&employee_id=eq.' + employeeId + '&work_date=eq.' + date + '&voided_at=is.null&order=created_at.asc&limit=20', 'get'),
    ]);
    return { punches, corrections };
  }

  async function webAdminSetDay(ctx, token, b) {
    auth.needAdmin(token);
    b = b || {};
    if (!isInt(b.employee_id) || !isDate(b.date)) fail('Bad request');
    if (b.date > today()) fail('Cannot edit a future date');
    if (b.date < await dataStart()) fail('Date is before the data start');
    const tIn = b.in ? String(b.in) : null, tOut = b.out ? String(b.out) : null;
    if ((tIn && !isTime(tIn)) || (tOut && !isTime(tOut))) fail('Time must be HH:MM');
    const status = b.status ? String(b.status) : null;
    if (status && STATUSES.indexOf(status) < 0) fail('Unknown status');
    const remark = b.remark ? String(b.remark).slice(0, 300) : null;
    const source = (b.source ? String(b.source) : 'Admin').slice(0, 80);
    if (!tIn && !tOut && !status && !b.night && !remark) fail('Nothing to save. Use "Clear my changes" to remove corrections.');
    const n = await db.rpc('admin_set_day', {
      p_employee: +b.employee_id, p_date: b.date, p_in: tIn, p_out: tOut, p_out_next_day: !!b.out_next_day,
      p_status: status, p_night: !!b.night, p_source: source, p_remark: remark,
    });
    return { ok: true, saved: n };
  }

  async function webAdminClearDay(ctx, token, b) {
    auth.needAdmin(token);
    b = b || {};
    if (!isInt(b.employee_id) || !isDate(b.date)) fail('Bad request');
    return { ok: true, cleared: await db.rpc('admin_clear_day', { p_employee: +b.employee_id, p_date: b.date }) };
  }

  /* ---------------- branch portal ---------------- */
  async function webBranchList() {
    const emps = await db.rest('employees?select=location&tracked=eq.true&active=eq.true&limit=1000', 'get');
    const cnt = {};
    emps.forEach((e) => { cnt[e.location] = (cnt[e.location] || 0) + 1; });
    return Object.keys(cnt).filter((l) => env[auth.brKey(l)]).sort().map((l) => ({ location: l, staff: cnt[l] }));
  }

  async function webBranchLogin(ctx, location, pin, name, client) {
    auth.secret();
    location = String(location || ''); name = String(name || '').replace(/\s+/g, ' ').trim();
    const cl = clientTag(ctx, client);
    if (name.length < 2 || name.length > 60) fail('Please type your name');
    const loc = (await webBranchList()).filter((b) => b.location === location)[0];
    if (!loc) fail('This branch is not set up yet. Ask admin.');
    const who = name, KEY = 'branch:' + location.toLowerCase();
    if (!(await db.rpc('admin_attempt_allowed', { p_key: KEY }))) {
      await db.rpc('branch_log_event', { p_branch: location, p_actor: who, p_action: 'login_fail', p_client: cl, p_detail: 'blocked (too many attempts)' });
      fail('Too many wrong attempts. Try again in 15 minutes.');
    }
    const ok = auth.checkBranchPin(location, pin);
    await db.rpc('admin_attempt_log', { p_key: KEY, p_ok: ok });
    await db.rpc('branch_log_event', { p_branch: location, p_actor: who, p_action: ok ? 'login_ok' : 'login_fail', p_client: cl, p_detail: ok ? null : 'wrong PIN' });
    if (!ok) fail('Wrong PIN');
    return { token: auth.makeBranchToken(location, who), seconds_left: auth.TTL_BRANCH, location, name };
  }

  async function webBranchLogout(ctx, token, client) {
    try {
      const d = auth.needBranch(token);
      await db.rpc('branch_log_event', { p_branch: d.l, p_actor: d.n, p_action: 'logout', p_client: clientTag(ctx, client), p_detail: null });
    } catch (e) { /* already expired: nothing to log */ }
    return { ok: true };
  }

  async function webBranchSet(ctx, token, b) {
    const d = auth.needBranch(token);
    b = b || {};
    if (!isInt(b.employee_id) || !isDate(b.date)) fail('Bad request');
    return db.rpc('branch_set_day', {
      p_branch: d.l, p_employee: +b.employee_id, p_date: b.date,
      p_extra: !!b.extra, p_night: !!b.night, p_remark: b.remark ? String(b.remark).slice(0, 300) : null,
      p_actor: d.n, p_client: clientTag(ctx, b.client),
    });
  }

  async function webBranchMonth(ctx, token) {
    const d = auth.needBranch(token);
    const t = today(), ds = await dataStart();
    let from = t.slice(0, 8) + '01'; if (from < ds) from = ds;
    const loc = encodeURIComponent(d.l);
    const emps = await db.rest('employees?select=id,name&tracked=eq.true&active=eq.true&location=ilike.' + loc + '&order=name.asc&limit=500', 'get');
    let rows = [];
    if (from <= t && emps.length) {
      rows = await db.all('v_daily_attendance?select=employee_id,work_date,status,in_time,out_time,late_out,night,branch_extra,branch_night,branch_entry,branch_by,flag'
        + '&location=ilike.' + loc + '&work_date=gte.' + from + '&work_date=lte.' + t + '&order=employee_id.asc,work_date.asc', 21000);
    }
    const ids = emps.map((e) => e.id).join(',');
    const entries = ids ? await db.rest('branch_entries?select=employee_id,work_date,extra_day,night,remark,entered_by,updated_at&work_date=gte.' + from
      + '&employee_id=in.(' + ids + ')&order=work_date.asc&limit=3000', 'get') : [];
    return {
      branch: d.l, who: d.n, month: t.slice(0, 7), from, today: t, employees: emps,
      rows: rows.map((r) => [r.employee_id, r.work_date, r.status, r.in_time, r.out_time, r.late_out ? 1 : 0, r.night ? 1 : 0,
        r.branch_extra ? 1 : 0, r.branch_night ? 1 : 0, r.branch_entry ? 1 : 0, r.branch_by || '', r.flag || '']),
      entries,
    };
  }

  async function webAdminBranchLog(ctx, token, f) {
    auth.needAdmin(token);
    f = f || {};
    let q = 'branch_log?select=id,at,branch,actor,action,employee_name,work_date,old_extra,old_night,new_extra,new_night,remark,no_punch,client,detail&order=at.desc';
    if (f.branch) q += '&branch=eq.' + encodeURIComponent(String(f.branch).slice(0, 60));
    if (f.action) { if (['login_ok', 'login_fail', 'logout', 'set', 'clear'].indexOf(f.action) < 0) fail('Bad request'); q += '&action=eq.' + f.action; }
    if (f.from) { if (!isDate(f.from)) fail('Bad request'); q += '&at=gte.' + f.from + 'T00:00:00%2B05:30'; }
    if (f.to) { if (!isDate(f.to)) fail('Bad request'); q += '&at=lt.' + addDay(f.to) + 'T00:00:00%2B05:30'; }
    if (f.q) {
      const t = String(f.q).replace(/[^\w .@-]/g, '').slice(0, 40);
      if (t) q += '&or=(' + ['actor', 'employee_name', 'remark'].map((c) => c + '.ilike.*' + encodeURIComponent(t) + '*').join(',') + ')';
    }
    const lim = Math.max(1, Math.min(+f.limit || 300, 1000));
    const [rows, todayRows, lastRows, branches] = await Promise.all([
      db.rest(q + '&limit=' + lim, 'get'),
      db.rest('branch_log?select=branch,action&at=gte.' + today() + 'T00:00:00%2B05:30&limit=2000', 'get'),
      db.rest('branch_log?select=branch,at,actor&action=eq.login_ok&order=at.desc&limit=300', 'get'),
      webBranchList(),
    ]);
    const st = { logins: 0, failed: 0, edits: 0 };
    todayRows.forEach((r) => { if (r.action === 'login_ok') st.logins++; else if (r.action === 'login_fail') st.failed++; else if (r.action === 'set' || r.action === 'clear') st.edits++; });
    const last = {};
    lastRows.forEach((r) => { if (!last[r.branch]) last[r.branch] = { at: r.at, actor: r.actor }; });
    return { rows, today: st, last_login: last, branches: branches.map((b) => b.location) };
  }

  /* ---------------- staff add / remove ----------------
   * Supabase is the single source of truth. apps-script/FormDropdownSync.gs (time trigger, every 10 min)
   * copies the active names into the Google Form dropdowns. */
  const FORM_NOTE = 'Saved. The Google Form dropdown refreshes by itself within 10 minutes.';

  async function webAdminAddEmployee(ctx, token, b) {
    auth.needAdmin(token);
    b = b || {};
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60 || !/^[A-Za-z][A-Za-z .'\-]*$/.test(name)) fail('Enter the name using letters only (2-60 characters)');
    const all = await db.rest('employees?select=id,name,location,active&limit=2000', 'get');
    const locs = {}; all.forEach((e) => (locs[e.location] = 1));
    const location = String(b.location || '');
    if (!locs[location]) fail('Pick a location from the list');
    const joined = b.joined_on ? String(b.joined_on) : today();
    if (!isDate(joined)) fail('Bad joining date');
    const dup = all.filter((e) => norm(e.name) === norm(name))[0];
    if (dup && dup.active) fail(dup.name + ' already exists (' + dup.location + ')');
    if (dup) await db.rest('employees?id=eq.' + dup.id, 'patch', { active: true, left_on: null, location, joined_on: joined });
    else await db.rest('employees', 'post', [{ name, location, active: true, tracked: true, joined_on: joined }]);
    return { ok: true, restored: !!dup, form: FORM_NOTE };
  }

  async function webAdminRemoveEmployee(ctx, token, b) {
    auth.needAdmin(token);
    b = b || {};
    if (!isInt(b.id)) fail('Bad request');
    const last = b.left_on ? String(b.left_on) : today();
    if (!isDate(last)) fail('Bad last working day');
    await db.rest('employees?id=eq.' + (+b.id), 'patch', { active: false, left_on: last });
    return { ok: true, form: FORM_NOTE };
  }

  async function webAdminRestoreEmployee(ctx, token, b) {
    auth.needAdmin(token);
    b = b || {};
    if (!isInt(b.id)) fail('Bad request');
    await db.rest('employees?id=eq.' + (+b.id), 'patch', { active: true, left_on: null });
    return { ok: true, form: FORM_NOTE };
  }

  /* ---------------- salary PREVIEW (extra feature, admin only) ----------------
   * Reads attendance only. It is NOT used by webAdminExportMonth, so the month-end Excel is unaffected. */
  async function webAdminSalaryMonth(ctx, token, month) {
    auth.needAdmin(token);
    if (!isMonth(month)) fail('Bad request');
    let salaries;
    try { salaries = await db.all('employee_salary?select=employee_id,monthly_salary&order=employee_id.asc', 5000); }
    catch (e) { return { setup_needed: true, month }; }          // sql/07_salary.sql not run yet
    const ds = await dataStart(), t = today();
    const y = +month.slice(0, 4), m = +month.slice(5), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mFrom = month + '-01', mTo = month + '-' + ('0' + last).slice(-2);
    let from = addDay(mFrom, -10), to = addDay(mTo, 10);          // a few days either side for the "Sunday inside a leave" rule
    if (from < ds) from = ds;
    if (to > t) to = t;
    const [emps, rows] = await Promise.all([
      db.rest('employees?select=id,name,location,active&tracked=eq.true&limit=2000', 'get'),
      from <= to ? db.all('v_daily_attendance?select=employee_id,work_date,status&work_date=gte.' + from + '&work_date=lte.' + to + '&order=work_date.asc,employee_id.asc', 60000) : [],
    ]);
    const res = salary.buildMonth({ month, emps, salaries, rows });
    res.today = t; res.salaries_loaded = salaries.length;
    return res;
  }

  /* ---------------- month-end Excel ---------------- */
  async function webAdminExportMonth(ctx, token, month) {
    auth.needAdmin(token);
    return exporter.build({ db, month, today: today(), hourIST: +new Date(clock().getTime() + 5.5 * 3600e3).getUTCHours(), dataStart: await dataStart() });
  }

  return {
    siteLogin, webEmployees, webRange, webCalendar, webDayPunches, webPhoto,
    webAdminLogin, webAdminPunches, webAdminSetDay, webAdminClearDay,
    webBranchList, webBranchLogin, webBranchLogout, webBranchSet, webBranchMonth, webAdminBranchLog,
    webAdminAddEmployee, webAdminRemoveEmployee, webAdminRestoreEmployee, webAdminExportMonth, webAdminSalaryMonth,
  };
}
module.exports = { createHandlers, STATUSES };
