'use strict';
/**
 * GET /api/health  -> is the site up, is Supabase reachable, and is the Google Form -> Supabase raw sync alive?
 * Safe to expose: it shows no names and no PINs. Bookmark it; use it for an uptime monitor.
 */
const { makeDb } = require('../lib/supabase');
const { makeAuth } = require('../lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const out = { ok: false, time: new Date().toISOString(), supabase: false, raw_punches: null, latest_punch: null, minutes_since_latest_punch: null, last_sync: null, sync_status: 'unknown' };
  try {
    const db = makeDb({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY });
    const [latest, sync] = await Promise.all([
      db.rest('raw_punches?select=punched_at,synced_at&order=punched_at.desc&limit=1', 'get'),
      db.rest('sync_log?select=*&order=created_at.desc&limit=1', 'get').catch(() => db.rest('sync_log?select=*&order=id.desc&limit=1', 'get')).catch(() => null),
    ]);
    out.supabase = true;
    if (latest && latest[0]) {
      out.latest_punch = latest[0].punched_at;
      out.minutes_since_latest_punch = Math.round((Date.now() - Date.parse(latest[0].punched_at)) / 60000);
    }
    if (sync && sync[0]) {
      const s = sync[0];
      const at = s.created_at || s.finished_at || s.at || s.ran_at || s.run_at || null;
      out.last_sync = { at, rows: s.rows_sent != null ? s.rows_sent : (s.rows != null ? s.rows : null), status: s.status || s.result || null };
      if (at) {
        const mins = (Date.now() - Date.parse(at)) / 60000;
        out.sync_status = mins < 15 ? 'running' : mins < 180 ? 'slow (check the Apps Script trigger)' : 'STOPPED (check the Apps Script trigger)';
      }
    }
    // which branch PIN variables this deployment can actually see (names + length only, never the PIN itself)
    try {
      const auth = makeAuth(process.env);
      const emps = await db.rest('employees?select=location&tracked=eq.true&active=eq.true&limit=1000', 'get');
      const locs = Array.from(new Set(emps.map((e) => e.location))).sort();
      out.branch_pins = locs.map((l) => { const k = auth.brKey(l), v = process.env[k]; return { location: l, variable: k, set: !!v, length: v ? v.length : 0, has_space_at_ends: v ? v !== v.trim() : false }; });
    } catch (e) { out.branch_pins = 'could not read'; }
    out.deployed_commit = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null;
    out.ok = true;
  } catch (e) {
    out.error = 'Database not reachable';
  }
  res.statusCode = out.ok ? 200 : 503;
  res.end(JSON.stringify(out));
};
