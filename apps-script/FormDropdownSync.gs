/**
 * FormDropdownSync.gs  -  keeps the Google Form name dropdowns equal to Supabase (single source of truth).
 * Add to the SAME Apps Script project as SupabaseSync.gs. Needs the same Script properties
 * (SUPABASE_URL, SUPABASE_SECRET_KEY, SHEET_ID).
 *
 * Run fdCheck() once (authorises the Form permission and prints what it would manage),
 * then run fdSetupTrigger() once. After that it runs every 10 minutes by itself:
 * staff added / removed on the dashboard appear in / vanish from the Form dropdown.
 */
function fdNorm_(v) { return String(v || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function fdSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 'busy';
  try {
    const s = sbSecrets_();
    const url = sbSS_().getFormUrl();
    if (!url) return 'The sheet has no linked Google Form.';
    const form = FormApp.openByUrl(url);
    const res = UrlFetchApp.fetch(s.url + '/rest/v1/employees?select=name,location,active&tracked=eq.true&limit=2000',
      { headers: sbHeaders_(s.key), muteHttpExceptions: true });
    if (res.getResponseCode() >= 300) throw new Error('Supabase ' + res.getResponseCode());
    const emps = JSON.parse(res.getContentText());
    const byLoc = {};
    emps.forEach(function (e) { (byLoc[e.location] = byLoc[e.location] || []).push(e); });
    const items = form.getItems().filter(function (it) { return it.getType() === FormApp.ItemType.LIST || it.getType() === FormApp.ItemType.MULTIPLE_CHOICE; });
    const used = {}, changed = [];
    Object.keys(byLoc).forEach(function (loc) {
      const names = {}; byLoc[loc].forEach(function (e) { names[fdNorm_(e.name)] = 1; });
      var best = null, bestN = 0;
      items.forEach(function (it) {
        if (used[it.getId()]) return;
        const ch = (it.getType() === FormApp.ItemType.LIST ? it.asListItem() : it.asMultipleChoiceItem()).getChoices();
        var n = 0; ch.forEach(function (c) { if (names[fdNorm_(c.getValue())]) n++; });
        if (n > bestN) { bestN = n; best = it; }
      });
      if (!best || bestN < 3) return;
      used[best.getId()] = 1;
      const li = best.getType() === FormApp.ItemType.LIST ? best.asListItem() : best.asMultipleChoiceItem();
      const cur = li.getChoices().map(function (c) { return c.getValue(); });
      const act = {}, gone = {};
      byLoc[loc].forEach(function (e) { (e.active ? act : gone)[fdNorm_(e.name)] = e.name; });
      const next = cur.filter(function (v) { return !gone[fdNorm_(v)]; });
      const have = {}; next.forEach(function (v) { have[fdNorm_(v)] = 1; });
      Object.keys(act).sort().forEach(function (k) { if (!have[k]) next.push(act[k]); });
      if (next.length && (next.length !== cur.length || next.some(function (v, i) { return v !== cur[i]; }))) {
        li.setChoiceValues(next); changed.push(loc);
      }
    });
    return changed.length ? 'Form dropdown updated: ' + changed.join(', ') : 'Form dropdown already up to date.';
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function fdCheck() {
  const url = sbSS_().getFormUrl();
  Logger.log('Linked form: ' + (url || 'NONE'));
  if (!url) return;
  FormApp.openByUrl(url).getItems().forEach(function (it) {
    const t = it.getType();
    if (t === FormApp.ItemType.LIST || t === FormApp.ItemType.MULTIPLE_CHOICE) {
      Logger.log('Question "' + it.getTitle() + '" has ' + (t === FormApp.ItemType.LIST ? it.asListItem() : it.asMultipleChoiceItem()).getChoices().length + ' choices');
    }
  });
  Logger.log('Dry sync: ' + fdSync());
}

function fdSetupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'fdSync') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('fdSync').timeBased().everyMinutes(10).create();
}
