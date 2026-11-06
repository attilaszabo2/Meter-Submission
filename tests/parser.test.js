const test = require('node:test');
const assert = require('node:assert');
const { parseBillEmail, parseFlipPayment, planSheetUpdate, readingRemindersFor } = require('../apps-script/Parser.js');

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

test('reads older bills that say HUF instead of Ft', () => {
  const bill = parseBillEmail({
    from: 'ugyfelszolgalat@online.mvmnext.hu',
    subject: 'Új földgázszámla készült 102753750709',
    body: '| Fizetendő összeg: |\n| |\n| 973 HUF |\n| Fizetési határidő: |\n| 2025.08.14. |\n| Szerződéses folyószámlaszám: |\n| 30830774 |\n| Számla sorszáma (közleménybe): |\n| 102753750709 |'
  });
  assert.strictEqual(bill.amount, 973);
  assert.strictEqual(bill.dueDate, '2025.08.14');
  assert.strictEqual(bill.invoiceNo, '102753750709');
});

const flipNotice = `Kedves Szabó Attila!\n\n| |\n\nA(z) *740732742* Flip azonosítóhoz kapcsolódóan elkészült az új havi számlád.\n\n| |\n\nSzámla összege: *6680 Ft*\n\n| |\n\nA számla fizetési határideje: *2026.11.17*`;

test('parses a Flip bill notice (no invoice number)', () => {
  const bill = parseBillEmail({ from: 'Flip <noreply@flip.hu>', subject: 'FLIP számlaértesítő', body: flipNotice });
  assert.deepStrictEqual(bill, { utility: 'internet', accountId: '740732742', invoiceNo: null, amount: 6680, dueDate: '2026.11.17' });
});

test('parses a Flip payment confirmation into invoice numbers', () => {
  const body = `| # Sikeres számlabefizetés |\n| Tranzakció azonosító: | 1018926952 |\nBefizetett számlák\n| Számla kelte: | 2026.10.02. |\n| Fizetési határidő: | 2026.10.19. |\n| Számla száma: | 5120265000640117 |\n| Folyószámla száma: | 900079239 |\n| Befizetett összeg: | 6 680 Ft |`;
  assert.deepStrictEqual(parseFlipPayment({ from: 'noreply@flip.hu', subject: 'Sikeres fizetés', body }),
    [{ invoiceNo: '5120265000640117', amount: 6680, monthKey: '2026.10' }]);
  assert.strictEqual(parseFlipPayment({ from: 'mvm@onlineugyintezes.mvmnext.hu', subject: 'Sikeres számlafizetés', body }), null);
  assert.strictEqual(parseFlipPayment({ from: 'noreply@flip.hu', subject: 'FLIP számlaértesítő', body }), null);
});

test('a bill without invoice number only fills or checks the amount', () => {
  const cols = { invoiceCol: 1, amountCol: 2 };
  const rows = [['Dátum'], ['2026.10', '5120265000640117', '6 680'], ['2026.11', '', '6 680'], ['2026.12', '', '']];
  assert.strictEqual(planSheetUpdate(rows, '2026.10', cols, { invoiceNo: null, amount: 6680 }).action, 'already');
  assert.strictEqual(planSheetUpdate(rows, '2026.11', cols, { invoiceNo: null, amount: 6680 }).action, 'already');
  assert.deepStrictEqual(planSheetUpdate(rows, '2026.12', cols, { invoiceNo: null, amount: 6680 }), { action: 'write', row: 4, writes: { 3: 6680 } });
  assert.strictEqual(planSheetUpdate(rows, '2026.11', cols, { invoiceNo: null, amount: 7000 }).action, 'conflict');
  // payment confirmation adds the invoice number next to a matching amount
  assert.deepStrictEqual(planSheetUpdate(rows, '2026.11', cols, { invoiceNo: '5120265000700000', amount: 6680 }), { action: 'write', row: 3, writes: { 2: '5120265000700000' } });
});

test('water reminder on the last day of the month', () => {
  assert.deepStrictEqual(readingRemindersFor({ year: 2026, month: 11, day: 30 }).map((r) => [r.utility, r.kind, r.end]), [['water', 'due', '2026.11.30']]);
  assert.deepStrictEqual(readingRemindersFor({ year: 2027, month: 2, day: 28 }).map((r) => r.utility), ['water']);
  assert.deepStrictEqual(readingRemindersFor({ year: 2028, month: 2, day: 28 }).map((r) => r.utility), []);
  assert.strictEqual(readingRemindersFor({ year: 2026, month: 11, day: 23 })[0].url, 'https://onlineugyintezes.mvmnext.hu/');
});
