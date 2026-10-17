'use strict';
const test = require('node:test'), assert = require('node:assert');
const ExcelJS = require('exceljs');
const { build } = require('../lib/export');
const { fakeDb } = require('./helpers');

test('month export builds a valid 4-sheet workbook with formulas', async () => {
  const days = [];
  for (let d = 1; d <= 14; d++) {
    const date = '2026-10-' + ('0' + d).slice(-2), sun = new Date(date + 'T00:00:00Z').getUTCDay() === 0;
    days.push({ employee_id: 1, work_date: date, status: sun ? 'Absent' : 'Present', in_time: sun ? null : '09:02:00', out_time: sun ? null : '18:20:00', night: d === 5 });
    days.push({ employee_id: 2, work_date: date, status: 'Absent', in_time: null, out_time: null, night: false });
  }
  const db = fakeDb({
    'employees?': [{ id: 1, name: 'Ravi Kumar', location: 'Okhla', joined_on: null, left_on: null, active: true }, { id: 2, name: 'Ghost Person', location: 'Okhla', joined_on: null, left_on: null, active: true }],
    'v_daily_attendance?': days,
  });
  const r = await build({ db, month: '2026-10', today: '2026-10-14', hourIST: 15, dataStart: '2026-10-01' });
  assert.equal(r.employees, 1); assert.equal(r.all, 2); assert.equal(r.url, null);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(r.b64, 'base64'));
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['Attendance Report', 'Data', 'Attendance Summary', 'Removed - No Attendance']);
  const sm = wb.getWorksheet('Attendance Summary');
  assert.equal(sm.getCell('A3').value, 'Ravi Kumar');
  assert.ok(sm.getCell('D3').value.formula);
  assert.equal(sm.getCell('J3').value, 1); // one night
  assert.equal(wb.getWorksheet('Removed - No Attendance').getCell('B2').value, 'Ghost Person');
  const rep = wb.getWorksheet('Attendance Report');
  assert.match(rep.getCell('H4').value.formula, /^IFERROR\(INDEX\(Data!/);
  assert.equal(rep.getCell('B2').value, 31);
});

test('export refuses bad months', async () => {
  const db = fakeDb({});
  await assert.rejects(build({ db, month: 'oct', today: '2026-10-14', hourIST: 9, dataStart: '2026-10-01' }), /Bad month/);
  await assert.rejects(build({ db, month: '2026-09', today: '2026-10-14', hourIST: 9, dataStart: '2026-10-01' }), /before the data start/);
  await assert.rejects(build({ db, month: '2026-12', today: '2026-10-14', hourIST: 9, dataStart: '2026-10-01' }), /not started/);
});
