'use strict';
/**
 * npm run smoke  -> opens the real site in Chromium with a FAKE API (no Supabase needed),
 * checks there are no JavaScript errors, the particle canvas is drawing, and saves screenshots to ./smoke-out.
 * One-time:  npm i -D playwright   (and: npx playwright install chromium)
 */
const path = require('path'), fs = require('fs'), http = require('http');
let chromium; try { chromium = require('playwright').chromium; } catch (e) { console.error('Install first:  npm i -D playwright && npx playwright install chromium'); process.exit(1); }

const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const emps = []; const L = ['Okhla', 'Gurgaon', 'Safdarjung HO'];
for (let i = 1; i <= 24; i++) emps.push({ id: i, name: 'Staff Member ' + i, location: L[i % 3], active: true, left_on: null });
const TODAY = '2026-10-14';
const rows = [];
for (const e of emps) for (let d = 1; d <= 14; d++) {
  const date = '2026-10-' + ('0' + d).slice(-2), sun = new Date(date + 'T00:00:00Z').getUTCDay() === 0;
  rows.push([e.id, date, sun ? (e.id % 6 === 0 && d === 4 ? 'Extra Day' : 'Sunday') : (e.id % 7 === 0 && d % 5 === 0 ? 'Absent' : (e.id % 7 === 3 && d === 8 ? 'Half Day' : 'Present')), sun ? null : '09:0' + (e.id % 9), sun ? null : '18:1' + (d % 9), sun ? null : 9.1, 0, 0, d % 4 === 0 ? 1 : 0, (e.id % 5 === 0 && d === 6 ? 1 : 0), '', '']);
}
const FAKE = {
  webEmployees: () => ({ employees: emps, today: TODAY, data_start: '2026-10-01', latest_punch: TODAY + 'T09:00:00+05:30' }),
  webRange: () => ({ from: '2026-10-01', to: TODAY, today: TODAY, rows }),
  webBranchList: () => [{ location: 'Okhla', staff: 8 }],
  webCalendar: (a) => ({ employee: emps[+a[0] - 1], month: a[1], today: TODAY, rows: rows.filter((r) => r[0] === +a[0]).map((r) => ({ work_date: r[1], status: r[2] === 'Sunday' ? 'Absent' : r[2], in_time: r[3], out_time: r[4], hours: r[5], ot_hours: r[6], late_in: false, late_out: !!r[8], night: false, flag: '', source: '', note: '' })) }),
  webDayPunches: () => ({ punches: [] }),
  webAdminLogin: () => ({ token: 'fake-admin', seconds_left: 1800 }),
  webAdminSalaryMonth: () => ({ month: '2026-10', today: TODAY, people: 2, total: 40500, base_pay: 39500, extra_pay: 1000, no_salary: [{ id: 9, name: 'No Pay Person', location: 'Okhla' }],
    rows: [{ id: 1, name: 'Staff Member 1', location: 'Gurgaon', monthly_salary: 31000, present: 10, half: 1, extra: 1, absent: 0, sunday_paid: 2, sunday_unpaid: 0, holiday: 1, missing: 0, paid_days: 14.5, base_pay: 14500, extra_pay: 1000, total: 15500, unpaid_sundays: [], days_in_month: 31, strip: 'PPPSPPHPPPSEPPPOPPSPPPPPPSPP---' },
           { id: 2, name: 'Staff Member 2', location: 'Okhla', monthly_salary: 31000, present: 8, half: 0, extra: 0, absent: 3, sunday_paid: 1, sunday_unpaid: 1, holiday: 1, missing: 1, paid_days: 11, base_pay: 25000, extra_pay: 0, total: 25000, unpaid_sundays: ['2026-10-11'], days_in_month: 31, strip: 'PPPSAAAAXAAPPPPPPSPPMPPPSPPP---' }] }),
};

(async () => {
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/rpc') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const j = JSON.parse(b || '{}'); const f = FAKE[j.fn];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(f ? { result: f(j.args || []) } : { error: 'not faked: ' + j.fn }));
      }); return;
    }
    const f = path.join(PUB, p === '/' ? 'index.html' : p);
    fs.readFile(f, (e, buf) => { if (e) { res.statusCode = 404; return res.end(); } res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.end(buf); });
  }).listen(0);
  const base = 'http://localhost:' + srv.address().port;
  const out = path.join(__dirname, '..', 'smoke-out'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const errors = [];
  let ok = true;
  const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) ok = false; };
  for (const vp of [{ w: +(process.env.VW || 1440), h: +(process.env.VH || 900), n: 'desktop' }, { w: 390, h: 800, n: 'phone' }]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    page.on('pageerror', (e) => errors.push(vp.n + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(vp.n + ': ' + m.text()); });
    await page.addInitScript(() => { try { localStorage.setItem('dccThemeMode', 'durga'); } catch (e) { /* blocked */ } });
    await page.goto(base); await page.waitForTimeout(2500);
    const painted = await page.evaluate(() => { const c = document.getElementById('fx'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 40) if (d[i] > 10) n++; return n; });
    check(painted > 20, vp.n + ': particle canvas is drawing (' + painted + ' px sampled)');
    check(await page.locator('#list button').count() > 5, vp.n + ': employee list loaded');
    await page.screenshot({ path: path.join(out, vp.n + '.png') });
    if (vp.n === 'desktop') {
      await page.fill('#q', 'Staff Member 3'); await page.waitForTimeout(400); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
      const w = await page.evaluate(() => document.querySelector('#center').getBoundingClientRect().width); check(await page.locator('.listcard').isVisible(), 'staff list stays visible');
      check(w > 750, 'calendar focus: calendar is wide (' + Math.round(w) + 'px at ' + vp.w + 'px screen)');
      check(await page.locator('.tile').count() > 20, 'calendar tiles drawn');
      const cnt = () => page.locator('#list button[data-id]').count();
      const before = await cnt();
      await page.selectOption('#special', 'night'); await page.waitForTimeout(400); const nN = await cnt();
      await page.selectOption('#special', 'extra'); await page.waitForTimeout(400); const nE = await cnt();
      await page.selectOption('#special', 'any'); await page.waitForTimeout(400); const nA = await cnt();
      check(nN > 0 && nN < before && nE > 0 && nE < before && nA === nN + nE, 'Special duty filter: night ' + nN + ', extra ' + nE + ', either ' + nA + ' of ' + before);
      check((await page.locator('#list .duty i').count()) > 0, 'duty badges show on the list');
      await page.selectOption('#special', ''); await page.waitForTimeout(200);
      await page.click('#dutyChips .chip[data-s="night"]'); await page.waitForTimeout(400);
      check(await cnt() === nN, 'clicking the Night chip filters the list (' + await cnt() + ')');
      await page.click('#dutyChips .chip[data-s="extra"]'); await page.waitForTimeout(400);
      check(await cnt() === nE, 'clicking the Extra day chip filters the list (' + await cnt() + ')');
      await page.click('#dutyChips .chip[data-s="extra"]'); await page.waitForTimeout(300);
      check(await cnt() === before, 'clicking the active chip again clears it');
      await page.click('#dutyChips .chip[data-s="half"]'); await page.waitForTimeout(400); const nH = await cnt();
      check(nH > 0 && nH < before, 'clicking the Half day chip filters the list (' + nH + ')');
      await page.selectOption('#special', ''); await page.waitForTimeout(300);
      check(await cnt() === before, 'Special duty filter resets to all staff');
      await page.screenshot({ path: path.join(out, 'calendar.png') });
      await page.click('#menuBtn'); await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(out, 'calendar-menu.png') });
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    }
    if (vp.n === 'desktop') {
      const fps = await page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); })(); }));
      console.log('INFO  frames per second in this browser: ' + Math.round(fps)); 
      await page.click('#themeBtn'); await page.waitForTimeout(200);
      check((await page.locator('#themeMenu button').count()) === 4, 'theme menu lists all 4 themes');
      await page.click('#themeMenu [data-tm="hydrangea"]'); await page.waitForTimeout(500);
      check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'hydrangea', 'theme menu switches to Hydrangea');
      await page.screenshot({ path: path.join(out, 'hydrangea.png') });
      await page.click('#themeBtn'); await page.waitForTimeout(200);
      await page.click('#themeMenu [data-tm="premium"]'); await page.waitForTimeout(900);
      check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'premium', 'theme menu reaches Professional');
      check((await page.evaluate(() => getComputedStyle(document.querySelector('.tile.Present') || document.body).fontFamily + '|' + getComputedStyle(document.body).fontFamily)).includes('Plus Jakarta'), 'premium font applied');
      await page.screenshot({ path: path.join(out, 'premium-calendar.png') });
      await page.evaluate(() => document.querySelector('#nav a[data-p="board"]').click()); await page.waitForTimeout(1800);
      check(await page.locator('.dbk').count() === 5, 'Daily board shows the five KPI cards');
      check((await page.locator('.dbbr').count()) === 3 && (await page.locator('.dbtab').count()) === 5, 'Daily board shows 3 branches and 5 tabs');
      await page.click('.dbtab[data-v="present"]'); await page.waitForTimeout(400);
      check((await page.locator('.dbt tbody tr').count()) > 5, 'Present tab lists many people');
      await page.click('.dbbr >> nth=0'); await page.waitForTimeout(400);
      check((await page.locator('.dbbr.on').count()) === 1, 'clicking a branch filters the board');
      await page.fill('#dbQ', 'Staff Member 3'); await page.waitForTimeout(300);
      check((await page.locator('.dbt tbody tr').count()) <= 3, 'search narrows the board list');
      await page.screenshot({ path: path.join(out, 'board.png') });
      await page.fill('#dbQ', ''); await page.click('.dbbr.on'); await page.fill('#dbDate', '2026-10-10'); await page.waitForTimeout(1800);
      await page.click('.dbtab[data-v="absent"]'); await page.waitForTimeout(400);
      check((await page.locator('.dbt tbody tr').count()) === 3 && (await page.textContent('.dbt')).includes('Absent this month'), 'past day: Absent tab lists the 3 absent people');
      await page.screenshot({ path: path.join(out, 'board-absent.png') });
      await page.fill('#dbDate', '2026-10-11'); await page.waitForTimeout(1800);
      check((await page.textContent('#center')).includes('is a day off'), 'Sunday shows the day-off note instead of absentees');
      await page.screenshot({ path: path.join(out, 'board-sunday.png') });
      await page.click('.dbseg button[data-db="day"] >> nth=1'); await page.waitForTimeout(1500);
      check(await page.locator('#nav a[data-p="salary"]').count() === 0, 'Salary page is hidden until admin mode');
      await page.evaluate(() => document.getElementById('adminBtn').click()); await page.fill('#pin', 'x'); await page.click('#pinForm button[type=submit]'); await page.waitForTimeout(800);
      check(await page.locator('#nav a[data-p="salary"]').count() === 1, 'admin mode adds the Salary (preview) page');
      await page.evaluate(() => document.querySelector('#nav a[data-p="salary"]').click()); await page.waitForTimeout(1500);
      check((await page.locator('.salcard').count()) === 2 && (await page.locator('.salcard .strip i').count()) === 62, 'salary cards with day strips shown for both people');
      await page.fill('#salQ', 'Member 2'); await page.waitForTimeout(300);
      check((await page.locator('.salcard').count()) === 1, 'salary search filters the cards'); await page.fill('#salQ', ''); await page.waitForTimeout(200);
      await page.click('[data-sal="view"][data-v="table"]'); await page.waitForTimeout(400);
      check((await page.locator('table.t tbody tr').count()) === 2, 'salary table view shows both people'); await page.click('[data-sal="view"][data-v="cards"]'); await page.waitForTimeout(400);
      check((await page.textContent('#center')).includes('Payable so far') && (await page.textContent('#center')).includes('not in the month-end Excel'), 'salary total and the preview-only note are shown');
      await page.screenshot({ path: path.join(out, 'salary.png') });
    }
    await page.close();
  }
  check(errors.length === 0, 'no JavaScript errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); srv.close();
  process.exit(ok ? 0 : 1);
})();
