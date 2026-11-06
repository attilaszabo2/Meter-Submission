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
  },
  internet: {
    senders: ['noreply@flip.hu'],
    subject: /számlaértesítő/i,
    accountLabel: /A\(z\)\s*(\d+)\s*Flip azonosító/,
    amountLabel: /Számla összege:\s*(-?[\d.\s]*\d)\s*Ft/,
    dueLabel: /fizetési határideje:\s*(\d{4}\.\d{2}\.\d{2})/i,
    // Flip's bill notice has no invoice number; it is filled in later from the payment confirmation.
    noInvoice: true
  }
};

var DEFAULT_AMOUNT_LABEL = /Fizetendő összeg:\s*(-?[\d.\s]*\d)\s*(?:Ft|HUF)/;
var DEFAULT_DUE_LABEL = /Fizetési határidő:\s*(\d{4}\.\d{2}\.\d{2})/;

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
 * Parses a "new bill" email (MVM Next gas/electricity, Flip internet).
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
  var amount = text.match(src.amountLabel || DEFAULT_AMOUNT_LABEL);
  var due = text.match(src.dueLabel || DEFAULT_DUE_LABEL);
  var account = text.match(src.accountLabel);
  var invoice = src.invoiceLabel ? text.match(src.invoiceLabel) : null;

  var invoiceNo = invoice ? invoice[1] : null;
  if (!invoiceNo && src.attachment) {
    (email.attachmentNames || []).forEach(function (name) {
      var m = String(name).match(src.attachment);
      if (m && !invoiceNo) invoiceNo = m[1];
    });
  }
  if (!invoiceNo && !src.noInvoice) {
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
 * Parses a Flip "Sikeres fizetés" (payment confirmation) email. It is the only Flip email
 * that carries invoice numbers.
 * @return {?{invoiceNo: string, amount: number, monthKey: string}[]} one entry per paid bill;
 *   monthKey is the month the bill was issued. null when it is not a Flip payment email.
 */
function parseFlipPayment(email) {
  if (senderAddress_(email.from) !== 'noreply@flip.hu' || !/sikeres fizetés/i.test(email.subject || '')) return null;
  var text = normalizeBody_(email.body);
  var re = /Számla kelte:\s*(\d{4})\.(\d{2})\.\d{2}\.?\s*Fizetési határidő:\s*[\d.]+\s*Számla száma:\s*(\d+)\s*Folyószámla száma:\s*\d+\s*Befizetett összeg:\s*(-?[\d.\s]*\d)\s*Ft/g;
  var out = [];
  var m;
  while ((m = re.exec(text)) !== null) {
    out.push({ invoiceNo: m[3], amount: parseForint_(m[4]), monthKey: m[1] + '.' + m[2] });
  }
  return out;
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
  if (rowIndex === -1) return { action: 'conflict', reason: 'nincs ' + monthKey + ' sor' };

  var row = rows[rowIndex];
  var currentInvoice = String(row[cols.invoiceCol] || '').trim();
  var currentAmount = String(row[cols.amountCol] || '').trim();
  var currentAmountNum = currentAmount === '' ? null : parseForint_(currentAmount);

  if (bill.invoiceNo && currentInvoice !== '' && currentInvoice !== bill.invoiceNo) {
    return {
      action: 'conflict',
      row: rowIndex + 1,
      reason: 'számla ' + currentInvoice
    };
  }
  if (currentAmountNum !== null && bill.amount !== null && currentAmountNum !== bill.amount &&
      !(bill.invoiceNo && currentInvoice === bill.invoiceNo)) {
    return {
      action: 'conflict',
      row: rowIndex + 1,
      reason: 'összeg ' + currentAmount + ' Ft'
    };
  }

  var writes = {};
  if (currentInvoice === '' && bill.invoiceNo) writes[cols.invoiceCol + 1] = bill.invoiceNo;
  if (currentAmountNum === null && bill.amount !== null) writes[cols.amountCol + 1] = bill.amount;
  if (Object.keys(writes).length === 0) return { action: 'already', row: rowIndex + 1 };
  return { action: 'write', row: rowIndex + 1, writes: writes };
}

/**
 * Meter-reading windows. Days are inclusive, in Hungarian local time; -1 means the last day of the month.
 * Gas: every month 23-26 (seen on MVM Next for Fő út 191, Nov 2026).
 * Electricity: quarterly, 1-7 of Feb, May, Aug, Nov (window was open until 11-07 in Nov 2026).
 * Water: submitted by hand, reminder on the 1st of every month.
 */
var ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
var READING_WINDOWS = [
  { utility: 'gas', name: 'Gáz', months: ALL_MONTHS, startDay: 23, endDay: 26, url: 'https://onlineugyintezes.mvmnext.hu/' },
  { utility: 'electricity', name: 'Villany', months: [2, 5, 8, 11], startDay: 1, endDay: 7, url: 'https://onlineugyintezes.mvmnext.hu/' },
  { utility: 'water', name: 'Víz', months: ALL_MONTHS, startDay: 1, endDay: 1 }
];

function daysInMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Returns the reminders to send today: one when a window opens and one on its last day
 * (a one-day window gets a single "due" reminder).
 * @param {{year: number, month: number, day: number}} today
 * @return {{utility: string, name: string, kind: string, start: string, end: string, url: ?string}[]}
 */
function readingRemindersFor(today, windows) {
  windows = windows || READING_WINDOWS;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var last = daysInMonth_(today.year, today.month);
  var out = [];
  windows.forEach(function (w) {
    if (w.months.indexOf(today.month) === -1) return;
    var start = w.startDay === -1 ? last : w.startDay;
    var end = w.endDay === -1 ? last : w.endDay;
    var kind = null;
    if (start === end && today.day === start) kind = 'due';
    else if (today.day === start) kind = 'opens';
    else if (today.day === end) kind = 'last-day';
    if (!kind) return;
    var prefix = today.year + '.' + pad(today.month) + '.';
    out.push({ utility: w.utility, name: w.name, kind: kind, start: prefix + pad(start), end: prefix + pad(end), url: w.url || null });
  });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { parseBillEmail: parseBillEmail, parseFlipPayment: parseFlipPayment, planSheetUpdate: planSheetUpdate, readingRemindersFor: readingRemindersFor, READING_WINDOWS: READING_WINDOWS };
}
