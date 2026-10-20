'use strict';
/**
 * POST /api/rpc   { "fn": "webRange", "args": ["2026-10-01", "2026-10-31"] }
 * One door for the whole dashboard. Only functions in the whitelist (lib/handlers.js) can be called.
 */
const { createRuntime } = require('../lib/runtime');
const { AppError } = require('../lib/util');

let rt = null;

function clientIp(req) {
  const h = req.headers || {};
  const xf = String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 200000) throw new AppError('Request too large'); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return send(405, { error: 'POST only' });
  try {
    rt = rt || createRuntime(process.env);
    let body;
    try { body = await readJson(req); } catch (e) { return send(400, { error: 'Bad request' }); }
    const fn = body && body.fn, args = Array.isArray(body && body.args) ? body.args : [];
    if (typeof fn !== 'string' || !Object.prototype.hasOwnProperty.call(rt.handlers, fn)) return send(404, { error: 'Unknown function' });
    if (fn !== 'siteLogin' && !rt.auth.siteOk(req.headers['x-site-token'])) return send(401, { error: 'Password required', code: 'SITE_LOCKED' });
    const result = await rt.handlers[fn]({ ip: clientIp(req) }, ...args);
    return send(200, { result: result === undefined ? null : result });
  } catch (e) {
    if (e instanceof AppError) return send(e.message === 'AUTH_EXPIRED' ? 401 : 400, { error: e.message, code: e.code || undefined });
    console.error('rpc error:', e && e.stack || e);
    return send(500, { error: 'Server error. Try again.' });
  }
};
