'use strict';
/** A tiny in-memory stand-in for Supabase so tests run offline. */
function fakeDb(routes) {
  const calls = [];
  const find = (path) => { for (const k of Object.keys(routes)) if (path.startsWith(k)) return routes[k]; return undefined; };
  const db = {
    calls,
    async rest(path, method, body) { calls.push({ path, method, body }); const r = find(path); return typeof r === 'function' ? r(path, body) : (r === undefined ? [] : r); },
    async rpc(fn, args) { calls.push({ rpc: fn, args }); const r = routes['rpc/' + fn]; return typeof r === 'function' ? r(args) : (r === undefined ? null : r); },
    async all(path) { calls.push({ path, all: true }); const r = find(path); return typeof r === 'function' ? r(path) : (r || []); },
  };
  return db;
}
const ENV = { SESSION_SECRET: 'x'.repeat(40), ADMIN_PIN: 'secret-pin', BRANCH_PIN_OKHLA: '1234', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x' };
module.exports = { fakeDb, ENV };
