'use strict';
/** Small helpers shared by the API. Dates are plain 'YYYY-MM-DD' strings in India time (IST). */

class AppError extends Error {
  constructor(message, code) { super(message); this.name = 'AppError'; this.code = code || ''; }
}
const fail = (msg, code) => { throw new AppError(msg, code); };

const isInt = (v) => /^\d{1,9}$/.test(String(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !isNaN(Date.parse(v + 'T00:00:00Z'));
const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));

const IST_MS = 5.5 * 3600 * 1000;
const istDate = (now) => new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
const istHour = (now) => new Date(now.getTime() + IST_MS).getUTCHours();
const addDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + (n === undefined ? 1 : n) * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5;
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dowOf = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8))).getUTCDay(); // 0 = Sunday

function colLetter(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

module.exports = { AppError, fail, isInt, isDate, isMonth, isTime, istDate, istHour, addDay, daysBetween, lastDayOfMonth, dowOf, colLetter, norm };
