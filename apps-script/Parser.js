/**
 * Pure helpers: no Google services here, so they can be unit tested with Node.
 */

/**
 * Which bill emails belong to which source. Each flat (see PROPERTIES in Config.js) picks the
 * sources it uses and the account number that belongs to it.
 */
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
  },
  one: {
    senders: ['no-reply@one.hu'],
    subject: /új számlája készült/i,
    accountLabel: /(\d+)\s*számlafizető azonosító/,
    amountLabel: /Számla alapján fizetendő:\s*(-?[\d.\s]*\d)\s*Ft/,
    // One's bill notice has no invoice number either.
    noInvoice: true
  },
  dijnet: {
    senders: ['ugyfelszolgalat@dijnet.hu'],
    subject: /díjnet számla érkezett/i,
    accountLabel: /Ügyfélazonosító\s*:\s*(\d+)/,
    invoiceLabel: /Terhelési összesítő\s*:\s*(\d+)/,
    dueLabel: /Fizetési határidő\s*:\s*(\d{4}\.\d{2}\.\d{2})/
  }
};

/** Senders of meter-reading confirmations and reading-window notices. */
var READING_SENDERS = ['noreply@vizmuvek.hu', 'server@dijnet.hu'];

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
 * Parses a water meter-reading confirmation: Fővárosi Vízművek "Mérőállás bejelentés - visszaigazolás"
 * or Díjnet "Mérőállás bejelentés".
 * @param {{from: string, subject: string, body: string}} email
 * @param {string} emailDate the date the email arrived, "yyyy.mm.dd" (used when the email has no reading date)
 * @return {?{meter: string, value: number, date: string}[]} null when it is not a reading confirmation
 */
function parseMeterReadings(email, emailDate) {
  var sender = senderAddress_(email.from);
  var subject = String(email.subject || '');
  var text = normalizeBody_(email.body);
  var out = [];
  var m;
  if (sender === 'noreply@vizmuvek.hu' && /mérőállás bejelentés/i.test(subject)) {
    var re = /Gyári szám:\s*([A-Z0-9]+)\s*Mérőállás:\s*(\d+(?:[.,]\d+)?)\s*m3/g;
    while ((m = re.exec(text)) !== null) out.push({ meter: m[1], value: parseForint_(m[2]), date: emailDate });
    return out;
  }
  if (sender === 'server@dijnet.hu' && /mérőállás bejelentés/i.test(subject)) {
    var re2 = /Gyáriszám:\s*([A-Z0-9]+).*?Aktuális mérőállás:\s*(\d+(?:[.,]\d+)?)\s*Leolvasás ideje:\s*(\d{4}\.\d{2}\.\d{2})/g;
    while ((m = re2.exec(text)) !== null) out.push({ meter: m[1], value: parseForint_(m[2]), date: m[3] });
    return out;
  }
  return null;
}

/**
 * Parses a Fővárosi Vízművek "diktálási időszak kezdetéről" notice.
 * @return {?{address: string, start: string, end: string}} null when it is not such a notice
 *   or it has no dates.
 */
function parseWaterWindow(email) {
  if (senderAddress_(email.from) !== 'noreply@vizmuvek.hu' || !/diktálási időszak kezdetéről/i.test(email.subject || '')) return null;
  var text = normalizeBody_(email.body);
  var start = text.match(/Diktálási időszak kezdete:\s*(\d{4}\.\d{2}\.\d{2})/);
  var end = text.match(/Diktálási időszak vége:\s*(\d{4}\.\d{2}\.\d{2})/);
  if (!start || !end) return null;
  var addr = text.match(/Felhasználási hely(?: címe)?:\s*(.+?)\s*(?:Gyári szám|$)/);
  return { address: addr ? addr[1].trim() : '', start: start[1], end: end[1] };
}

/**
 * Decides what to write for one meter reading.
 * @param {string[][]} rows display values of the tab, header row included
 * @param {string} monthKey e.g. "2026.10" (the month of the reading)
 * @param {number} col zero-based column of this meter
 * @param {number} value the reading
 * @return {{action: string, row?: number, writes?: Object, reason?: string}} same shape as planSheetUpdate
 */
function planReadingUpdate(rows, monthKey, col, value) {
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() !== monthKey) continue;
    var current = String(rows[i][col] || '').trim();
    if (current === '') {
      var writes = {};
      writes[col + 1] = value;
      return { action: 'write', row: i + 1, writes: writes };
    }
    if (parseForint_(current) === value) return { action: 'already', row: i + 1 };
    return { action: 'conflict', row: i + 1, reason: 'mérőállás ' + current };
  }
  return { action: 'conflict', reason: 'nincs ' + monthKey + ' sor' };
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

/**
 * Reminders for reading windows with exact dates (from Vízművek notices): one on the last day.
 * @param {{year: number, month: number, day: number}} today
 * @param {{utility: string, name: string, start: string, end: string, url: ?string}[]} windows
 */
function datedRemindersFor(today, windows) {
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var key = today.year + '.' + pad(today.month) + '.' + pad(today.day);
  return (windows || []).filter(function (w) { return w.end === key; }).map(function (w) {
    return { utility: w.utility, name: w.name, kind: 'last-day', start: w.start, end: w.end, url: w.url || null };
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseBillEmail: parseBillEmail, parseFlipPayment: parseFlipPayment, planSheetUpdate: planSheetUpdate,
    readingRemindersFor: readingRemindersFor, READING_WINDOWS: READING_WINDOWS,
    parseMeterReadings: parseMeterReadings, parseWaterWindow: parseWaterWindow, planReadingUpdate: planReadingUpdate,
    datedRemindersFor: datedRemindersFor
  };
}
