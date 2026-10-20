'use strict';
const { makeDb } = require('./supabase');
const { makeAuth } = require('./auth');
const { makeDrive } = require('./drive');
const { createHandlers } = require('./handlers');
const exporter = require('./export');

/** Wires everything together from environment variables. */
function createRuntime(env, overrides) {
  const o = overrides || {};
  const db = o.db || makeDb({ url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY });
  const auth = makeAuth(env, o.now);
  const drive = o.drive || makeDrive(env);
  const handlers = createHandlers({ env, db, auth, drive, exporter: o.exporter || exporter, now: o.now });
  return { db, auth, drive, handlers };
}
module.exports = { createRuntime };
