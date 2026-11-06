/**
 * Pure helpers: no Google services here, so they can be unit tested with Node.
 */

/** Which bill emails belong to which utility, and which accounts belong to Fő út 191. */
var BILL_SOURCES = {
  gas: {
    senders: ['ugyfelszolgalat@online.mvmnext.hu'],
    subject: /földgázszámla/i,
    accountLabel: /Szerződéses folyószámlaszám:\s*(\d+)/,
    invoiceLabel: /Számla sorszáma[^:]*:\s*(\d+)/,
    attachment: /^Földgáz_(\d+)_/i
  },
  electricity: {
    senders: ['onlineugyfelszolgalat@mvmee.hu'],
    subject: /villanyszáml/i,
    accountLabel: /Vevő \(fizető\) azonosító:\s*(\d+)/,
    invoiceLabel: /Számla adatai \(közleménybe\):\s*\d+\s+(\d+)/,
    attachment: /^Villany_(\d+)_/i
  }
};

/** Flattens an email body so that "Label: | | value" layouts become "Label: value". */
function normalizeBody_(body) {
  return String(body || '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ') // markdown links
    .replace(/[|#*]/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');
}

/** "4.055" or "11 375" or "-258" -> number */
function parseForint_(text) {
  var cleaned = String(text).replace(/[\s.]/g, '').replace(',', '.');
  var n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function senderAddress_(from) {
  var m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

/**
 * Parses an MVM Next "new bill" email.
 * @param {{from: string, subject: string, body: string, attachmentNames: string[]}} email
 * @return {?{utility: string, accountId: string, invoiceNo: string, amount: number, dueDate: string}}
 *   null when the email is not an MVM bill notice.
 */
function parseBillEmail(email) {
  var sender = senderAddress_(email.from);
  var utility = null;
  Object.keys(BILL_SOURCES).forEach(function (key) {
    var src = BILL_SOURCES[key];
    if (src.senders.indexOf(sender) !== -1 && src.subject.test(email.subject || '')) utility = key;
  });
  if (!utility) return null;

  var src = BILL_SOURCES[utility];
  var text = normalizeBody_(email.body);
  var amount = text.match(/Fizetendő összeg:\s*(-?[\d.\s]*\d)\s*Ft/);
  var due = text.match(/Fizetési határidő:\s*(\d{4}\.\d{2}\.\d{2})/);
  var account = text.match(src.accountLabel);
  var invoice = text.match(src.invoiceLabel);

  var invoiceNo = invoice ? invoice[1] : null;
  if (!invoiceNo) {
    (email.attachmentNames || []).forEach(function (name) {
      var m = String(name).match(src.attachment);
      if (m && !invoiceNo) invoiceNo = m[1];
    });
  }
  if (!invoiceNo) {
    var subj = String(email.subject || '').match(/(\d{10,})/);
    if (subj) invoiceNo = subj[1];
  }

  return {
    utility: utility,
    accountId: account ? account[1] : null,
    invoiceNo: invoiceNo,
    amount: amount ? parseForint_(amount[1]) : null,
    dueDate: due ? due[1] : null
  };
}

/**
 * Decides what to write into a utility tab for one bill.
 * @param {string[][]} rows display values of the tab, header row included
 * @param {string} monthKey e.g. "2026.11" (the month the bill email arrived)
 * @param {{invoiceCol: number, amountCol: number}} cols zero-based column indexes
 * @param {{invoiceNo: string, amount: number}} bill
 * @return {{action: string, row?: number, writes?: Object, reason?: string}}
 *   action "write" (row is 1-based, writes maps 1-based column -> value),
 *   "already" (nothing to do) or "conflict" (needs a human look).
 */
function planSheetUpdate(rows, monthKey, cols, bill) {
  var rowIndex = -1;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === monthKey) { rowIndex = i; break; }
  }
  if (rowIndex === -1) return { action: 'conflict', reason: 'No row for ' + monthKey };

  var row = rows[rowIndex];
  var currentInvoice = String(row[cols.invoiceCol] || '').trim();
  var currentAmount = String(row[cols.amountCol] || '').trim();
  var currentAmountNum = currentAmount === '' ? null : parseForint_(currentAmount);

  if (currentInvoice !== '' && currentInvoice !== bill.invoiceNo) {
    return {
      action: 'conflict',
      row: rowIndex + 1,
      reason: monthKey + ' already has invoice ' + currentInvoice + ' (new bill is ' + bill.invoiceNo + ')'
    };
  }
  if (currentAmountNum !== null && bill.amount !== null && currentAmountNum !== bill.amount && currentInvoice !== bill.invoiceNo) {
    return {
      action: 'conflict',
      row: rowIndex + 1,
      reason: monthKey + ' already shows ' + currentAmount + ' Ft (new bill is ' + bill.amount + ' Ft)'
    };
  }

  var writes = {};
  if (currentInvoice === '' && bill.invoiceNo) writes[cols.invoiceCol + 1] = bill.invoiceNo;
  if (currentAmountNum === null && bill.amount !== null) writes[cols.amountCol + 1] = bill.amount;
  if (Object.keys(writes).length === 0) return { action: 'already', row: rowIndex + 1 };
  return { action: 'write', row: rowIndex + 1, writes: writes };
}

/**
 * Meter-reading windows. Days are inclusive, in Hungarian local time.
 * Gas: every month 23-26 (seen on MVM Next for Fő út 191, Nov 2026).
 * Electricity: quarterly, 1-7 of Feb, May, Aug, Nov (window was open until 11-07 in Nov 2026).
 */
var READING_WINDOWS = [
  { utility: 'gas', name: 'Gáz', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], startDay: 23, endDay: 26 },
  { utility: 'electricity', name: 'Villany', months: [2, 5, 8, 11], startDay: 1, endDay: 7 }
];

/**
 * Returns the reminders to send today: one when a window opens and one on its last day.
 * @param {{year: number, month: number, day: number}} today
 * @return {{utility: string, name: string, kind: string, start: string, end: string}[]}
 */
function readingRemindersFor(today, windows) {
  windows = windows || READING_WINDOWS;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var out = [];
  windows.forEach(function (w) {
    if (w.months.indexOf(today.month) === -1) return;
    var kind = null;
    if (today.day === w.startDay) kind = 'opens';
    else if (today.day === w.endDay) kind = 'last-day';
    if (!kind) return;
    var prefix = today.year + '.' + pad(today.month) + '.';
    out.push({ utility: w.utility, name: w.name, kind: kind, start: prefix + pad(w.startDay), end: prefix + pad(w.endDay) });
  });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { parseBillEmail: parseBillEmail, planSheetUpdate: planSheetUpdate, readingRemindersFor: readingRemindersFor, READING_WINDOWS: READING_WINDOWS };
}
