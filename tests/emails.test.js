const test = require('node:test');
const assert = require('node:assert');
const { renderBillEmail, renderReminderEmail, renderSummaryEmail, formatFt } = require('../apps-script/Emails.js');

test('formats forints with thin grouping and a real minus', () => {
  assert.strictEqual(formatFt(11375), '11 375 Ft');
  assert.strictEqual(formatFt(-1967), '−1 967 Ft');
  assert.strictEqual(formatFt(0), '0 Ft');
});

test('bill email has amount, due date and pay link', () => {
  const e = renderBillEmail({ utilityName: 'Gáz', amount: 4055, dueDate: '2026.11.19', invoiceNo: '103004748147', tab: 'Gáz', monthKey: '2026.11', written: true }, 'https://x.test/');
  assert.strictEqual(e.subject, 'Új gázszámla: 4 055 Ft, határidő 2026.11.19');
  assert.match(e.html, /4 055 Ft/);
  assert.match(e.html, /href="https:\/\/x.test\/"/);
  assert.match(e.html, /Beírtam/);
});

test('reminder email subjects', () => {
  assert.match(renderReminderEmail({ name: 'Gáz', kind: 'opens', start: '2026.11.23', end: '2026.11.26' }, 'u').subject, /most nyílik/);
  assert.match(renderReminderEmail({ name: 'Gáz', kind: 'last-day', start: '2026.11.23', end: '2026.11.26' }, 'u').subject, /ma zárul/);
});

test('summary email lists written bills and escapes text', () => {
  const r = {
    written: [{ monthKey: '2026.11', tab: 'Gáz', bill: { invoiceNo: '1', amount: 4055 } }],
    already: [],
    conflicts: [{ monthKey: '2026.09', tab: 'Gáz', bill: { invoiceNo: '2', amount: -1967 }, reason: 'összeg 0 Ft' }],
    unreadable: [{ date: '2025.08.06', subject: '<b>x</b>' }],
    otherAddress: 20
  };
  const e = renderSummaryEmail('Kész', 'Intro', r, '');
  assert.strictEqual(e.subject, 'Kész');
  assert.match(e.html, /Beírt számlák/);
  assert.match(e.html, /nézd meg kézzel/);
  assert.match(e.html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(e.html, /<b>x<\/b>/);
});
