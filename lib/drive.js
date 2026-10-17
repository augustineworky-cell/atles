'use strict';
/**
 * Punch photos from Google Drive, read with a SERVICE ACCOUNT (no personal login).
 * Setup: Google Cloud -> create a service account -> enable the Drive API -> create a JSON key ->
 * put the JSON in GOOGLE_SERVICE_ACCOUNT_JSON -> share the Form's upload folder with the account's e-mail (Viewer).
 */
const crypto = require('crypto');
const { AppError } = require('./util');

function parseAccount(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  if (t[0] !== '{') { try { t = Buffer.from(t, 'base64').toString('utf8'); } catch (e) { return null; } }
  try { const j = JSON.parse(t); return j.client_email && j.private_key ? j : null; } catch (e) { return null; }
}

function makeDrive(env, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  let cache = { tok: '', exp: 0 };

  async function token() {
    const acc = parseAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!acc) throw new AppError('Photos are not set up yet (add PHOTO_PROXY_URL + PHOTO_PROXY_SECRET in Vercel; see apps-script/PhotoProxy.gs).');
    if (cache.tok && cache.exp > Date.now() + 60000) return cache.tok;
    const iat = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: acc.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 });
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(acc.private_key).toString('base64url');
    const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + sig });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) { console.error('Drive token error: ' + JSON.stringify(j).slice(0, 300)); throw new AppError('Could not sign in to Google Drive.'); }
    cache = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return cache.tok;
  }

  /** Preferred (no Google Cloud): the Apps Script PhotoProxy running as the Drive owner. */
  async function viaProxy(fileId) {
    const u = env.PHOTO_PROXY_URL + (env.PHOTO_PROXY_URL.indexOf('?') < 0 ? '?' : '&') + 'id=' + encodeURIComponent(fileId) + '&s=' + encodeURIComponent(env.PHOTO_PROXY_SECRET);
    let r;
    try { r = await f(u, { redirect: 'follow' }); } catch (e) { throw new AppError('Photo service is not reachable.'); }
    const j = await r.json().catch(() => null);
    if (!j) throw new AppError('Photo service returned an unreadable answer (check the web app is deployed for "Anyone").');
    if (j.error) throw new AppError(j.error === 'forbidden' ? 'Photo service secret does not match.' : String(j.error).slice(0, 160));
    return { m: j.m || 'image/jpeg', b: j.b };
  }
  const proxyOn = () => !!(env.PHOTO_PROXY_URL && env.PHOTO_PROXY_SECRET);

  /** returns { m: mime, b: base64 } */
  async function photo(fileId) {
    if (proxyOn()) return viaProxy(fileId);
    const tk = await token();
    const H = { Authorization: 'Bearer ' + tk };
    const meta = await f('https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=size,mimeType,thumbnailLink&supportsAllDrives=true', { headers: H });
    if (meta.status === 404 || meta.status === 403) throw new AppError('Drive: this file is not shared with the photo service account.');
    if (!meta.ok) throw new AppError('Drive error ' + meta.status);
    const info = await meta.json();
    let res;
    if (+info.size > 1500000 && info.thumbnailLink) res = await f(info.thumbnailLink.replace(/=s\d+$/, '=s1000'), { headers: H });
    else res = await f('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true', { headers: H });
    if (!res.ok) throw new AppError('Drive error ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3200000) throw new AppError('Photo is too large to show here. Use "Open full photo".');
    return { m: res.headers.get('content-type') || info.mimeType || 'image/jpeg', b: buf.toString('base64') };
  }
  return { photo, configured: () => proxyOn() || !!parseAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON) };
}
module.exports = { makeDrive, parseAccount };
