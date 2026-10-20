'use strict';
/** Server-side Supabase access (PostgREST). The secret key never reaches the browser. */
const { AppError } = require('./util');

function makeDb(cfg, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const url = String(cfg.url || '').replace(/\/+$/, '');
  const key = String(cfg.key || '');

  async function rest(path, method, body) {
    if (!url || !key) throw new AppError('Server is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)');
    const headers = { apikey: key };
    if (key.indexOf('eyJ') === 0) headers.Authorization = 'Bearer ' + key; // legacy JWT keys only
    const opt = { method: String(method || 'get').toUpperCase(), headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    if (opt.method === 'POST' && !path.startsWith('rpc/')) headers.Prefer = 'return=minimal';
    let r;
    try { r = await f(url + '/rest/v1/' + path, opt); }
    catch (e) { console.error('Supabase network error: ' + e.message); throw new AppError('Database is not reachable. Try again.'); }
    const text = await r.text();
    if (r.status >= 300) {
      console.error('Supabase ' + r.status + ': ' + text.slice(0, 500));
      let msg = '';
      try { const j = JSON.parse(text); if (j && j.code === 'P0001' && j.message) msg = String(j.message).slice(0, 160); } catch (e) { /* not JSON */ }
      throw new AppError(msg || 'Database error. Try again.'); // msg = a rule raised by our own SQL (safe to show)
    }
    return text ? JSON.parse(text) : null;
  }
  const rpc = (fn, args) => rest('rpc/' + fn, 'post', args);

  /** Reads every page of a view/table (PostgREST caps one reply at 1000 rows). */
  async function all(path, maxRows) {
    const out = [];
    const cap = maxRows || 50000;
    for (let off = 0; off < cap; off += 1000) {
      const page = await rest(path + '&limit=1000&offset=' + off, 'get');
      out.push.apply(out, page);
      if (page.length < 1000) break;
    }
    return out;
  }
  return { rest, rpc, all };
}
module.exports = { makeDb };
