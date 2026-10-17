'use strict';
const test = require('node:test'), assert = require('node:assert');
const { makeAuth } = require('../lib/auth');
const { ENV } = require('./helpers');

test('admin token works, expires and cannot be forged', () => {
  let t = Date.parse('2026-10-15T10:00:00Z');
  const a = makeAuth(ENV, () => new Date(t));
  const tok = a.makeAdminToken();
  a.needAdmin(tok);
  assert.throws(() => a.needAdmin(tok.slice(0, -2) + 'xx'), /AUTH_EXPIRED/);
  assert.throws(() => a.needAdmin(''), /AUTH_EXPIRED/);
  t += 31 * 60 * 1000;
  assert.throws(() => a.needAdmin(tok), /AUTH_EXPIRED/);
});

test('PIN check', () => {
  const a = makeAuth(ENV);
  assert.ok(a.checkAdminPin('secret-pin'));
  assert.ok(!a.checkAdminPin('secret-pi'));
  assert.ok(!a.checkAdminPin(''));
  assert.ok(!a.checkAdminPin(null));
});

test('branch token carries location, rejects tampering', () => {
  const a = makeAuth(ENV);
  const tok = a.makeBranchToken('Okhla', 'Ravi');
  assert.deepStrictEqual({ l: a.needBranch(tok).l, n: a.needBranch(tok).n }, { l: 'Okhla', n: 'Ravi' });
  const parts = tok.split('.');
  const evil = Buffer.from(JSON.stringify({ l: 'Gurgaon', n: 'Ravi', x: 9999999999 })).toString('base64url');
  assert.throws(() => a.needBranch(['B', evil, parts[2]].join('.')), /AUTH_EXPIRED/);
  assert.throws(() => a.needAdmin(tok), /AUTH_EXPIRED/); // a branch token is never an admin token
});

test('branch PIN property names', () => {
  const a = makeAuth(ENV);
  assert.equal(a.brKey('Safdarjung HO'), 'BRANCH_PIN_SAFDARJUNG_HO');
  assert.equal(a.brKey('okhla'), 'BRANCH_PIN_OKHLA');
  assert.ok(a.checkBranchPin('Okhla', '1234'));
  assert.ok(!a.checkBranchPin('Okhla', '12345'));
  assert.ok(!a.checkBranchPin('Gurgaon', '1234')); // no PIN set -> never matches
});

test('site password gate', () => {
  const off = makeAuth(ENV);
  assert.ok(off.siteOk(''));
  const on = makeAuth(Object.assign({}, ENV, { SITE_PASSWORD: 'open' }));
  assert.ok(!on.siteOk(''));
  assert.ok(on.checkSitePassword('open') && !on.checkSitePassword('nope'));
  assert.ok(on.siteOk(on.makeSiteToken()));
});
