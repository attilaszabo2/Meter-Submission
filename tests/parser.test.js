const test = require('node:test');
const assert = require('node:assert');
const { parseBillEmail, planSheetUpdate, readingRemindersFor } = require('../apps-script/Parser.js');

// Trimmed from real MVM Next emails (Nov/Oct 2026).
const gasBody = `MVM E-számla - Földgáz
| Számla adatai |
| |
| Fizetendő összeg: |
| |
| 4.055 Ft |
| Fizetési határidő: |
| 2026.11.19. [](https://onlineugyintezes.mvmnext.hu/szamla_naptarba_mentes?data=x) |
| Szerződéses folyószámlaszám: |
| |
| 30830774 |
| Számla sorszáma (közleménybe): |
| |
| 103004748147 |`;

const elecBody = `MVM E-számla - Áram
Fizetendő összeg:
11.375 Ft
Fizetési határidő:
2026.10.26.
Vevő (fizető) azonosító:
2600107389
Bankszámlaszám:
10700024-71534116-53000004
Számla adatai (közleménybe):
2600107389 847303494385`;

test('parses a gas bill email', () => {
  const bill = parseBillEmail({
    from: 'MVM Next online ügyfélszolgálat <ugyfelszolgalat@online.mvmnext.hu>',
    subject: 'Új földgázszámla készült 103004748147',
    body: gasBody,
    attachmentNames: ['Földgáz_103004748147_2026.11.02.PDF']
  });
  assert.deepStrictEqual(bill, {
    utility: 'gas', accountId: '30830774', invoiceNo: '103004748147', amount: 4055, dueDate: '2026.11.19'
  });
});

test('parses an electricity bill email', () => {
  const bill = parseBillEmail({
    from: 'onlineugyfelszolgalat@mvmee.hu',
    subject: 'Új villanyszámlája készült',
    body: elecBody,
    attachmentNames: []
  });
  assert.deepStrictEqual(bill, {
    utility: 'electricity', accountId: '2600107389', invoiceNo: '847303494385', amount: 11375, dueDate: '2026.10.26'
  });
});

test('falls back to the attachment name for the invoice number', () => {
  const bill = parseBillEmail({
    from: 'onlineugyfelszolgalat@mvmee.hu',
    subject: 'Új villanyszámlája készült',
    body: 'Fizetendő összeg: 8.416 Ft Vevő (fizető) azonosító: 2602900993',
    attachmentNames: ['Villany_848303147010_2026.10.15.PDF']
  });
  assert.strictEqual(bill.invoiceNo, '848303147010');
  assert.strictEqual(bill.accountId, '2602900993');
});

test('ignores payment confirmations and other senders', () => {
  assert.strictEqual(parseBillEmail({ from: 'mvm@onlineugyintezes.mvmnext.hu', subject: 'Sikeres számlafizetés', body: '' }), null);
  assert.strictEqual(parseBillEmail({ from: 'x@example.com', subject: 'Új földgázszámla készült', body: gasBody }), null);
});

const gasCols = { invoiceCol: 2, amountCol: 3 };
const gasRows = [
  ['Dátum', 'Mérőállás', 'Számla', 'Fizetendő'],
  ['2026.10', '', '', '0'],
  ['2026.11', '', '', '4 055'],
  ['2026.12', '', '', '']
];

test('writes invoice and amount into an empty month', () => {
  const plan = planSheetUpdate(gasRows, '2026.12', gasCols, { invoiceNo: '1', amount: 500 });
  assert.deepStrictEqual(plan, { action: 'write', row: 4, writes: { 3: '1', 4: 500 } });
});

test('only adds the invoice number when the typed amount matches', () => {
  const plan = planSheetUpdate(gasRows, '2026.11', gasCols, { invoiceNo: '103004748147', amount: 4055 });
  assert.deepStrictEqual(plan, { action: 'write', row: 3, writes: { 3: '103004748147' } });
});

test('flags a different amount instead of overwriting', () => {
  const plan = planSheetUpdate(gasRows, '2026.10', gasCols, { invoiceNo: '107002351768', amount: 1200 });
  assert.strictEqual(plan.action, 'conflict');
});

test('flags a second invoice in the same month', () => {
  const rows = [['Dátum'], ['2026.12', '', '999', '500']];
  assert.strictEqual(planSheetUpdate(rows, '2026.12', gasCols, { invoiceNo: '1', amount: 500 }).action, 'conflict');
});

test('does nothing when the bill is already in', () => {
  const rows = [['Dátum'], ['2026.12', '', '1', '500']];
  assert.strictEqual(planSheetUpdate(rows, '2026.12', gasCols, { invoiceNo: '1', amount: 500 }).action, 'already');
});

test('flags a missing month row', () => {
  assert.strictEqual(planSheetUpdate(gasRows, '2027.01', gasCols, { invoiceNo: '1', amount: 1 }).action, 'conflict');
});

test('reading reminders', () => {
  assert.deepStrictEqual(readingRemindersFor({ year: 2026, month: 11, day: 23 }).map((r) => [r.utility, r.kind]), [['gas', 'opens']]);
  assert.deepStrictEqual(readingRemindersFor({ year: 2026, month: 11, day: 26 }).map((r) => [r.utility, r.kind]), [['gas', 'last-day']]);
  assert.deepStrictEqual(readingRemindersFor({ year: 2027, month: 2, day: 1 }).map((r) => [r.utility, r.kind]), [['electricity', 'opens']]);
  assert.deepStrictEqual(readingRemindersFor({ year: 2026, month: 12, day: 1 }), []);
  assert.strictEqual(readingRemindersFor({ year: 2026, month: 11, day: 7 })[0].end, '2026.11.07');
});
