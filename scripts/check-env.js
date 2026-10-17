'use strict';
/** npm run check  -> verifies .env / Vercel settings and that Supabase answers. (Replaces webSetupCheck.) */
const fs = require('fs'), path = require('path');
const f = path.join(__dirname, '..', '.env');
if (fs.existsSync(f)) fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); });
const { createRuntime } = require('../lib/runtime');
const { parseAccount } = require('../lib/drive');
const e = process.env;
const yn = (b) => (b ? 'OK     ' : 'MISSING');
(async () => {
  console.log(yn(e.SUPABASE_URL), 'SUPABASE_URL');
  console.log(yn(e.SUPABASE_SECRET_KEY), 'SUPABASE_SECRET_KEY');
  console.log(yn(e.ADMIN_PIN), 'ADMIN_PIN');
  console.log(yn((e.SESSION_SECRET || '').length >= 32), 'SESSION_SECRET (32+ chars)');
  console.log(e.SITE_PASSWORD ? 'ON     SITE_PASSWORD (whole site is password protected)' : 'off    SITE_PASSWORD (anyone with the link can view)');
  console.log((e.PHOTO_PROXY_URL && e.PHOTO_PROXY_SECRET) ? 'OK     PHOTO_PROXY (punch photos via Apps Script)' : parseAccount(e.GOOGLE_SERVICE_ACCOUNT_JSON) ? 'OK     GOOGLE_SERVICE_ACCOUNT_JSON (punch photos)' : 'off    GOOGLE_SERVICE_ACCOUNT_JSON (punch photos will not show)');
  const rt = createRuntime(e);
  try {
    const d = await rt.handlers.webEmployees({});
    console.log('OK      Supabase: ' + d.employees.length + ' employees, today ' + d.today + ', latest punch ' + d.latest_punch);
    const b = await rt.handlers.webBranchList({});
    console.log('Branches with a PIN: ' + (b.map((x) => x.location + ' (' + x.staff + ' staff)').join(', ') || 'NONE - set BRANCH_PIN_OKHLA etc.'));
  } catch (err) { console.log('FAILED  Supabase: ' + err.message); process.exitCode = 1; }
})();
