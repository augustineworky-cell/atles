/**
 * DCC Attendance -> Supabase sync
 * Source : this spreadsheet, tab "Form responses 3"
 * Target : Supabase table public.raw_punches  (append-only, safe to re-run)
 * Scope  : only punches on/after SB_CFG.CUTOFF (IST). Older data is never sent.
 *
 * Script Properties required (Project Settings > Script properties):
 *   SUPABASE_URL         e.g. https://yrodtskgezofeqpifkvy.supabase.co
 *   SUPABASE_SECRET_KEY  secret / service_role key (NEVER put it in code or GitHub)
 *   SHEET_ID             ID of the Attendance Register sheet (only if script is standalone)
 *
 * All names are prefixed sb/SB_ so they cannot clash with your existing script.
 */
const SB_CFG = {
  SHEET_NAME: 'Form responses 3',
  CUTOFF: '2026-10-01T00:00:00+05:30',
  TZ: 'Asia/Kolkata',
  TAIL_ROWS: 5000,   // only the last N rows are scanned (fast); October is well inside this
  BATCH: 500,
};

function sbSecrets_() {
  const p = PropertiesService.getScriptProperties();
  const url = p.getProperty('SUPABASE_URL');
  const key = p.getProperty('SUPABASE_SECRET_KEY');
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in Script properties');
  return { url: url.replace(/\/+$/, ''), key: key };
}

// Works both when bound to the sheet and when standalone (set SHEET_ID property)
function sbSS_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function sbHeaders_(key, extra) {
  const h = { apikey: key };
  if (key.indexOf('eyJ') === 0) h.Authorization = 'Bearer ' + key; // legacy JWT keys only
  return Object.assign(h, extra || {});
}

function sbHash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// Each location has its own Name/Photo column pair in the form sheet (0-based indexes)
function sbPickNamePhoto_(row, loc) {
  const L = String(loc).toUpperCase();
  const pairs = L.indexOf('SAFDARJUNG') >= 0 ? [[3, 4]] :
                L.indexOf('GURGAON') >= 0 ? [[5, 6]] :
                L.indexOf('OKHLA') >= 0 ? [[7, 8]] : [];
  [[3, 4], [5, 6], [7, 8]].forEach(function (p) { pairs.push(p); }); // fallback: first non-empty pair
  for (var i = 0; i < pairs.length; i++) {
    const n = String(row[pairs[i][0]] || '').replace(/\s+/g, ' ').trim();
    if (n) return { name: n, photo: String(row[pairs[i][1]] || '').trim() || null };
  }
  return null;
}

/** MAIN: run by triggers. Safe to run any number of times. */
function sbSyncPunches() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // another run in progress
  const stats = { scanned: 0, inScope: 0, sent: 0, skipped: 0 };
  try {
    const s = sbSecrets_();
    const sh = sbSS_().getSheetByName(SB_CFG.SHEET_NAME);
    const last = sh.getLastRow();
    const start = Math.max(2, last - SB_CFG.TAIL_ROWS + 1);
    const values = sh.getRange(start, 1, last - start + 1, 9).getValues();
    const cutoffMs = new Date(SB_CFG.CUTOFF).getTime();
    const byId = {};

    values.forEach(function (r, i) {
      stats.scanned++;
      var ts = r[0];
      if (!(ts instanceof Date)) ts = new Date(ts);
      if (!ts || isNaN(ts.getTime())) { stats.skipped++; return; }
      if (ts.getTime() < cutoffMs) return;            // before 1 Oct -> ignore
      stats.inScope++;
      const loc = String(r[1] || '').trim();
      const ioRaw = String(r[2] || '').trim();
      const io = /^in$/i.test(ioRaw) ? 'In' : /^out$/i.test(ioRaw) ? 'Out' : null;
      const np = sbPickNamePhoto_(r, loc);
      if (!loc || !io || !np) { stats.skipped++; return; }
      const id = sbHash_([ts.getTime(), loc.toUpperCase(), io, np.name.toLowerCase()].join('|'));
      byId[id] = {
        punch_id: id,
        punched_at: Utilities.formatDate(ts, SB_CFG.TZ, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"),
        punch_date: Utilities.formatDate(ts, SB_CFG.TZ, 'yyyy-MM-dd'),
        location: loc,
        io: io,
        io_raw: ioRaw,
        employee_name_raw: np.name,
        photo_url: np.photo,
        sheet_row: start + i,
        source: 'google_form',
      };
    });

    const rows = Object.keys(byId).map(function (k) { return byId[k]; });
    for (var i = 0; i < rows.length; i += SB_CFG.BATCH) {
      const batch = rows.slice(i, i + SB_CFG.BATCH);
      const res = UrlFetchApp.fetch(s.url + '/rest/v1/raw_punches?on_conflict=punch_id', {
        method: 'post',
        contentType: 'application/json',
        headers: sbHeaders_(s.key, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
        payload: JSON.stringify(batch),
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() >= 300) throw new Error('Supabase ' + res.getResponseCode() + ': ' + res.getContentText());
      stats.sent += batch.length;
    }
    sbLog_(s, stats, 'ok', null);
  } catch (e) {
    try { sbLog_(sbSecrets_(), stats, 'error', String(e)); } catch (_) {}
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Attendance sync FAILED', String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function sbLog_(s, st, status, err) {
  UrlFetchApp.fetch(s.url + '/rest/v1/sync_log', {
    method: 'post', contentType: 'application/json',
    headers: sbHeaders_(s.key, { Prefer: 'return=minimal' }),
    payload: JSON.stringify({ rows_scanned: st.scanned, rows_in_scope: st.inScope, rows_sent: st.sent,
                              rows_skipped: st.skipped, status: status, error: err }),
    muteHttpExceptions: true,
  });
}

/** Run ONCE: creates the schedule (every 15 min + on every new form submit). */
function sbSetupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sbSyncPunches') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sbWatchdog') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sbSyncPunches').timeBased().everyMinutes(5).create();                 // safety net
  ScriptApp.newTrigger('sbSyncPunches').forSpreadsheet(sbSS_()).onFormSubmit().create();      // instant, on every punch
  ScriptApp.newTrigger('sbWatchdog').timeBased().everyHours(1).create();                      // alarm if sync stops
}

/** Hourly alarm: e-mails you if the last SUCCESSFUL sync is older than 3 hours (06:00-23:00 IST only). */
function sbWatchdog() {
  const hr = +Utilities.formatDate(new Date(), SB_CFG.TZ, 'H');
  if (hr < 6 || hr > 23) return;
  const s = sbSecrets_();
  const res = UrlFetchApp.fetch(s.url + '/rest/v1/sync_log?select=*&status=eq.ok&order=created_at.desc&limit=1',
    { headers: sbHeaders_(s.key), muteHttpExceptions: true });
  let at = null;
  try { const j = JSON.parse(res.getContentText()); at = j[0] && (j[0].created_at || j[0].at); } catch (e) { /* ignore */ }
  const ageH = at ? (Date.now() - new Date(at).getTime()) / 3600000 : 999;
  if (ageH > 3) {
    const props = PropertiesService.getScriptProperties();
    const sentOn = props.getProperty('WATCHDOG_SENT');
    const key = Utilities.formatDate(new Date(), SB_CFG.TZ, 'yyyy-MM-dd-H');
    if (sentOn !== key) {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Attendance sync has not run for ' + Math.round(ageH) + ' hours',
        'Open the Apps Script project -> Triggers and check sbSyncPunches. Or run sbSyncPunches manually once.');
      props.setProperty('WATCHDOG_SENT', key);
    }
  }
}

/** Run once first, to check URL + key work. */
function sbTestConnection() {
  const s = sbSecrets_();
  const res = UrlFetchApp.fetch(s.url + '/rest/v1/raw_punches?select=punch_id&limit=1',
    { headers: sbHeaders_(s.key), muteHttpExceptions: true });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
}
