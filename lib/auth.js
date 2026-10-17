'use strict';
/** Admin / branch / site tokens: HMAC-signed, expiring, nothing stored on the server. */
const crypto = require('crypto');
const { AppError } = require('./util');

const TTL_ADMIN = 30 * 60;      // 30 minutes
const TTL_BRANCH = 3 * 60 * 60; // 3 hours
const TTL_SITE = 12 * 60 * 60;  // 12 hours

function makeAuth(env, now) {
  const clock = now || (() => new Date());
  const nowSec = () => Math.floor(clock().getTime() / 1000);

  const hmac = (msg) => crypto.createHmac('sha256', secret()).update(msg).digest('base64url');
  function secret() {
    const s = env.SESSION_SECRET || '';
    if (s.length < 32 || !env.ADMIN_PIN) throw new AppError('Admin mode is not configured on the server yet');
    return s;
  }
  const hash = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
  /** constant-time compare of two strings (hash first so lengths never leak) */
  const safeEq = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));

  /* ---- admin ---- */
  function makeAdminToken() { const exp = nowSec() + TTL_ADMIN; return exp + '.' + hmac('adm.' + exp); }
  function needAdmin(token) {
    const t = String(token || ''), i = t.indexOf('.');
    const exp = t.slice(0, i), sig = t.slice(i + 1);
    if (i < 1 || !/^\d+$/.test(exp) || +exp < nowSec() || !safeEq(sig, hmac('adm.' + exp))) throw new AppError('AUTH_EXPIRED');
  }
  const checkAdminPin = (pin) => typeof pin === 'string' && pin.length > 0 && pin.length < 100 && safeEq(pin, env.ADMIN_PIN || '');

  /* ---- branch ---- */
  const brKey = (loc) => 'BRANCH_PIN_' + String(loc).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  function makeBranchToken(location, who) {
    const payload = Buffer.from(JSON.stringify({ l: location, n: who, x: nowSec() + TTL_BRANCH })).toString('base64url');
    return 'B.' + payload + '.' + hmac('br.' + payload);
  }
  function needBranch(token) {
    const t = String(token || '').split('.');
    if (t.length !== 3 || t[0] !== 'B' || !safeEq(t[2], hmac('br.' + t[1]))) throw new AppError('AUTH_EXPIRED');
    let d;
    try { d = JSON.parse(Buffer.from(t[1], 'base64url').toString('utf8')); } catch (e) { throw new AppError('AUTH_EXPIRED'); }
    if (!d || !d.l || !(d.x > nowSec())) throw new AppError('AUTH_EXPIRED');
    return d; // {l: location, n: who, x: expiry}
  }
  const checkBranchPin = (location, pin) => {
    const real = env[brKey(location)] || '';
    return typeof pin === 'string' && pin.length > 0 && pin.length < 100 && real.length > 0 && safeEq(pin, real);
  };

  /* ---- whole-site password (optional) ---- */
  const siteLocked = () => !!env.SITE_PASSWORD;
  function makeSiteToken() { const exp = nowSec() + TTL_SITE; return exp + '.' + crypto.createHmac('sha256', env.SESSION_SECRET || env.SITE_PASSWORD).update('site.' + exp).digest('base64url'); }
  function siteOk(token) {
    if (!siteLocked()) return true;
    const t = String(token || ''), i = t.indexOf('.');
    const exp = t.slice(0, i), sig = t.slice(i + 1);
    if (i < 1 || !/^\d+$/.test(exp) || +exp < nowSec()) return false;
    const want = crypto.createHmac('sha256', env.SESSION_SECRET || env.SITE_PASSWORD).update('site.' + exp).digest('base64url');
    return safeEq(sig, want);
  }
  const checkSitePassword = (pw) => typeof pw === 'string' && pw.length > 0 && pw.length < 200 && safeEq(pw, env.SITE_PASSWORD || '');

  return { secret, safeEq, hash, makeAdminToken, needAdmin, checkAdminPin, brKey, makeBranchToken, needBranch, checkBranchPin,
    siteLocked, makeSiteToken, siteOk, checkSitePassword, TTL_ADMIN, TTL_BRANCH };
}
module.exports = { makeAuth };
