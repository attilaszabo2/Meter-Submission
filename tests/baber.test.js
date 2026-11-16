const test = require('node:test');
const assert = require('node:assert');
const {
  parseBillEmail, parseMeterReadings, parseWaterWindow, planReadingUpdate, datedRemindersFor, readingRemindersFor
} = require('../apps-script/Parser.js');

// Trimmed from real emails for Babér utca 35 (2026).
const dijnetBody = `Kedves Ügyfelünk!
Tájékoztatjuk, hogy a Díjnet rendszerbe új számlája érkezett.
A számla(k) főbb adatai:
Számlakibocsátó : Díjbeszedő Holding Zrt.
Ügyfélazonosító : 545817121 (Dijbeszedő)
* Terhelési összesítő:  671386206
* Fizetési határidő : 2026.07.15
* Összeg : 1657 Ft
* Fizetendő összeg:  1657 Ft*
*A fizetendő összeg a jelen értesítésünket követően bármikor módosulhat a szolgáltató egyenlegközlése esetén.`;

const oneBody = `| Kedves Ügyfelünk! Aktuális, 2007228555 számlafizető azonosítóhoz tartozó havi számlája elkészült, melynek részleteit az alábbiakban küldjük. |
| |
| | Számla alapján fizetendő: 30.780 Ft | [](http://www.one.hu/one-fiok/szamlaim/) |
| | Fizetési határidő: 2026.10.26. | [](https://www.one.hu/shop/szamlabefizetes#amount=30780) |`;

const vizmuvekReading = `| Tisztelt SZABÓ ATTILA! Mérőállását az alábbi adatokkal sikeresen rögzítettük: Gyári szám: K2407689400004030 Mérőállás: 45 m3 Gyári szám: K2407689500010370 Mérőállás: 40 m3 Amennyiben fényképet is csatolt a mérőálláshoz, annak csatolása is sikeresen megtörtént! |`;

const dijnetReading = `Tisztelt Ügyfelünk!

Mérőállás bejelentését továbbítottuk a Díjbeszedő Holding Zrt. felé.

Mérőállások:
1. mérőállás:
Mérőhely azonosító: 2094609
Gyáriszám: K2407689500010370
Megjelenési név: Babér_meleg
Aktuális mérőállás: 49
Leolvasás ideje: 2026.08.26

2. mérőállás:
Mérőhely azonosító: 2094607
Gyáriszám: K2407689400004030
Megjelenési név: Babér_hideg
Aktuális mérőállás: 57
Leolvasás ideje: 2026.08.26`;

const windowBody = `Tisztelt SZABÓ ATTILA!
A Társaságunk internetes ügyfélszolgálatán tett regisztrációja alapján tájékoztatjuk, hogy az alábbi mérő(k) diktálási időszaka megkezdődött.
Felhasználási hely címe: Budapest - XIII. Babér utca 35   II. 15
Gyári szám: K2407689400004030
Felhasználási hely címe: Budapest - XIII. Babér utca 35   II. 15
Gyári szám: K2407689500010370
Diktálási időszak kezdete: 2026.10.27
Diktálási időszak vége: 2026.11.04
Bejelentkezés: https://ugyfelszolgalat.vizmuvek.hu`;

test('parses a Díjnet bill notice', () => {
  const bill = parseBillEmail({ from: 'dijnet.hu <ugyfelszolgalat@dijnet.hu>', subject: 'Díjnet számla érkezett', body: dijnetBody, attachmentNames: [] });
  assert.deepStrictEqual(bill, { utility: 'dijnet', accountId: '545817121', invoiceNo: '671386206', amount: 1657, dueDate: '2026.07.15' });
});

test('ignores other Díjnet emails', () => {
  assert.strictEqual(parseBillEmail({ from: 'ugyfelszolgalat@dijnet.hu', subject: 'Díjnet SzámlaPlusz díjbekérő érkezett', body: 'x', attachmentNames: [] }), null);
});

test('parses a One bill notice', () => {
  const bill = parseBillEmail({ from: 'One <no-reply@one.hu>', subject: 'One | Új számlája készült', body: oneBody, attachmentNames: [] });
  assert.deepStrictEqual(bill, { utility: 'one', accountId: '2007228555', invoiceNo: null, amount: 30780, dueDate: '2026.10.26' });
});

test('parses a Vízművek reading confirmation with two meters', () => {
  const r = parseMeterReadings({ from: 'noreply@vizmuvek.hu', subject: 'Mérőállás bejelentés - visszaigazolás', body: vizmuvekReading }, '2026.04.21');
  assert.deepStrictEqual(r, [
    { meter: 'K2407689400004030', value: 45, date: '2026.04.21' },
    { meter: 'K2407689500010370', value: 40, date: '2026.04.21' }
  ]);
});

test('parses a Díjnet reading confirmation', () => {
  const r = parseMeterReadings({ from: 'server@dijnet.hu', subject: 'Mérőállás bejelentés', body: dijnetReading }, '2026.08.27');
  assert.deepStrictEqual(r, [
    { meter: 'K2407689500010370', value: 49, date: '2026.08.26' },
    { meter: 'K2407689400004030', value: 57, date: '2026.08.26' }
  ]);
});

test('reading parser ignores bill emails', () => {
  assert.strictEqual(parseMeterReadings({ from: 'ugyfelszolgalat@dijnet.hu', subject: 'Díjnet számla érkezett', body: dijnetBody }, '2026.07.01'), null);
});

test('parses a Vízművek reading-window notice', () => {
  const w = parseWaterWindow({ from: 'Fővárosi Vízművek Zrt. <noreply@vizmuvek.hu>', subject: 'Tájékoztatás ügyfél általi diktálási időszak kezdetéről', body: windowBody });
  assert.strictEqual(w.start, '2026.10.27');
  assert.strictEqual(w.end, '2026.11.04');
  assert.match(w.address, /Babér utca 35/);
});

test('plans reading writes without overwriting', () => {
  const rows = [['Dátum', 'meleg', 'hideg'], ['2026.08', '', '49'], ['2026.10', '55', '']];
  assert.deepStrictEqual(planReadingUpdate(rows, '2026.08', 1, 49), { action: 'write', row: 2, writes: { 2: 49 } });
  assert.deepStrictEqual(planReadingUpdate(rows, '2026.08', 2, 49), { action: 'already', row: 2 });
  assert.deepStrictEqual(planReadingUpdate(rows, '2026.08', 2, 57), { action: 'conflict', row: 2, reason: 'mérőállás 49' });
  assert.strictEqual(planReadingUpdate(rows, '2027.01', 1, 1).action, 'conflict');
});

test('dated window reminds on its last day only', () => {
  const w = [{ utility: 'water', name: 'Víz', start: '2026.10.27', end: '2026.11.04', url: 'https://ugyfelszolgalat.vizmuvek.hu' }];
  assert.deepStrictEqual(datedRemindersFor({ year: 2026, month: 11, day: 3 }, w), []);
  assert.deepStrictEqual(datedRemindersFor({ year: 2026, month: 11, day: 4 }, w), [
    { utility: 'water', name: 'Víz', kind: 'last-day', start: '2026.10.27', end: '2026.11.04', url: 'https://ugyfelszolgalat.vizmuvek.hu' }
  ]);
});

test('Babér electricity window: every month 22-28', () => {
  const windows = [{ utility: 'electricity', name: 'Villany', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], startDay: 22, endDay: 28, url: 'u' }];
  assert.strictEqual(readingRemindersFor({ year: 2026, month: 12, day: 22 }, windows)[0].kind, 'opens');
  assert.strictEqual(readingRemindersFor({ year: 2026, month: 12, day: 28 }, windows)[0].kind, 'last-day');
  assert.strictEqual(readingRemindersFor({ year: 2026, month: 12, day: 25 }, windows).length, 0);
});
