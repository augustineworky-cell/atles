/**
 * PhotoProxy.gs - lets the Vercel site show punch photos WITHOUT any Google Cloud setup.
 * It runs as YOU (the Drive owner), so it can read the Form's photo files. Vercel calls it with a secret.
 *
 * SETUP (3 minutes)
 * 1. Add this file to the same Apps Script project as SupabaseSync.gs.
 * 2. Project Settings -> Script properties -> add  PHOTO_SECRET = a long random text (30+ characters).
 * 3. Deploy -> New deployment -> type "Web app" -> Execute as: Me -> Who has access: Anyone -> Deploy.
 *    Copy the URL that ends with /exec  (use the plain  https://script.google.com/macros/s/.../exec  form).
 * 4. In Vercel -> Settings -> Environment Variables add
 *      PHOTO_PROXY_URL    = that /exec URL
 *      PHOTO_PROXY_SECRET = the same text as PHOTO_SECRET
 *    then Redeploy.
 * 5. Run photoProxyTest once in the editor and press Allow (Drive permission).
 * Without the secret nobody can read anything, and only file IDs that exist in raw_punches are accepted by the site.
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const out = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  const secret = PropertiesService.getScriptProperties().getProperty('PHOTO_SECRET') || '';
  if (secret.length < 20 || p.s !== secret) return out({ error: 'forbidden' });
  const id = String(p.id || '');
  if (!/^[\w-]{15,80}$/.test(id)) return out({ error: 'bad id' });
  try {
    const f = DriveApp.getFileById(id);
    var blob = f.getBlob();
    if (blob.getBytes().length > 1500000) blob = f.getThumbnail();
    return out({ m: blob.getContentType(), b: Utilities.base64Encode(blob.getBytes()) });
  } catch (err) {
    return out({ error: 'Drive: file not available to the owner (' + String(err.message || err).slice(0, 80) + ')' });
  }
}

/** Run once: grants the Drive permission and checks the 5 latest punch photos. */
function photoProxyTest() {
  const s = sbSecrets_();
  const res = UrlFetchApp.fetch(s.url + '/rest/v1/raw_punches?select=photo_url,employee_name_raw&photo_url=not.is.null&order=punched_at.desc&limit=5',
    { headers: sbHeaders_(s.key), muteHttpExceptions: true });
  JSON.parse(res.getContentText()).forEach(function (r) {
    const m = String(r.photo_url).match(/[?&]id=([\w-]+)|\/d\/([\w-]+)/), id = m ? (m[1] || m[2]) : '';
    try { Logger.log('OK   ' + r.employee_name_raw + ' | ' + DriveApp.getFileById(id).getName()); }
    catch (e) { Logger.log('FAIL ' + r.employee_name_raw + ' | ' + String(e.message).slice(0, 100)); }
  });
}
