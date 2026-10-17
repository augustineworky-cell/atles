'use strict';
const test = require('node:test'), assert = require('node:assert');
const { ENV } = require('./helpers');

function call(handler, body, headers) {
  return new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(t) { resolve({ code: this.statusCode, json: JSON.parse(t) }); } };
    handler({ method: 'POST', body, headers: headers || {}, socket: {} }, res);
  });
}
function fresh(env) {
  Object.keys(process.env).filter((k) => /^(SUPABASE|ADMIN|SESSION|BRANCH|SITE)/.test(k)).forEach((k) => delete process.env[k]);
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../api/rpc')];
  return require('../api/rpc');
}

test('unknown / private functions cannot be called', async () => {
  const h = fresh(ENV);
  assert.equal((await call(h, { fn: 'constructor', args: [] })).code, 404);
  assert.equal((await call(h, { fn: '__proto__', args: [] })).code, 404);
  assert.equal((await call(h, { fn: 'dataStart', args: [] })).code, 404);
  assert.equal((await call(h, { args: [] })).code, 404);
});

test('GET is refused; bad admin token gives 401 AUTH_EXPIRED', async () => {
  const h = fresh(ENV);
  const res = { setHeader() {}, end(t) { this.t = t; } };
  await h({ method: 'GET', headers: {} }, res); assert.equal(res.statusCode, 405);
  const r = await call(h, { fn: 'webAdminClearDay', args: ['bad', { employee_id: 1, date: '2026-10-10' }] });
  assert.equal(r.code, 401); assert.equal(r.json.error, 'AUTH_EXPIRED');
});

test('site password: locked until siteLogin', async () => {
  const h = fresh(Object.assign({}, ENV, { SITE_PASSWORD: 'open sesame' }));
  const locked = await call(h, { fn: 'webEmployees', args: [] });
  assert.equal(locked.code, 401); assert.equal(locked.json.code, 'SITE_LOCKED');
  const bad = await call(h, { fn: 'siteLogin', args: ['nope'] });
  assert.equal(bad.code, 400);
  const ok = await call(h, { fn: 'siteLogin', args: ['open sesame'] });
  assert.equal(ok.code, 200); assert.ok(ok.json.result.token);
  // with the token the gate opens (then fails only because Supabase is fake)
  const next = await call(h, { fn: 'webEmployees', args: [] }, { 'x-site-token': ok.json.result.token });
  assert.notEqual(next.json.code, 'SITE_LOCKED');
});
