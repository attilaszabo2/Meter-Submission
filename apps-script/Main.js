/**
 * Számlák automation: imports MVM Next bills from Gmail into this sheet,
 * emails you about new bills, and reminds you when a meter reading is due.
 *
 * First time: run `setup` once from the Apps Script editor and approve the access prompt.
 */

var CONFIG = {
  // Only bills for these accounts (Fő út 191) are written to the sheet.
  accounts: {
    gas: '30830774',          // Szerződéses folyószámlaszám
    electricity: '2600107389', // Vevő (fizető) azonosító
    internet: '740732742'      // Flip azonosító
  },
  tabs: {
    gas: { name: 'Gáz', invoiceCol: 2, amountCol: 3 },          // C = Számla, D = Fizetendő
    electricity: { name: 'Villany', invoiceCol: 1, amountCol: 2 }, // B = Számla, C = Fizetendő
    internet: { name: 'Internet', invoiceCol: 1, amountCol: 2 }    // B = Számla, C = Fizetendő
  },
  utilityNames: { gas: 'Gáz', electricity: 'Villany', internet: 'Internet' },
  pay: {
    gas: { url: 'https://onlineugyintezes.mvmnext.hu/', label: 'Fizetés az MVM Next oldalán' },
    electricity: { url: 'https://onlineugyintezes.mvmnext.hu/', label: 'Fizetés az MVM Next oldalán' },
    internet: { url: 'https://www.flip.hu/myflip/ugyfelszolgalat/kezdo', label: 'Fizetés a Flip oldalán' }
  },
  processedLabel: 'Szamlak-feldolgozva',
  // Leave empty to send to the account that owns the script.
  notifyEmail: '',
  timeZone: 'Europe/Budapest'
};

/** Run once: installs the schedules and imports past bills without emailing about each one. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['checkBills', 'checkReadingReminders'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkBills').timeBased().everyDays(1).atHour(7).inTimezone(CONFIG.timeZone).create();
  ScriptApp.newTrigger('checkReadingReminders').timeBased().everyDays(1).atHour(8).inTimezone(CONFIG.timeZone).create();
  var result = processBills_({ notify: false, query: '', includeProcessed: false });
  sendSummary_('Számlák automatizálás bekapcsolva',
    'Az automatikus számlafigyelés be van kapcsolva. Ezeket a régebbi számlákat dolgoztam fel:', result,
    'Mostantól naponta egyszer (reggel 7-kor) ellenőrzöm az új MVM és Flip számlákat, és szólok, ha mérőállást kell leadni.');
}

/**
 * Re-reads every MVM bill email, including ones already processed, and fills any cells that are still empty.
 * Never overwrites. Safe to run any time.
 */
function backfill() {
  var result = processBills_({ notify: false, query: '', includeProcessed: true });
  sendSummary_('Számlák: régi számlák pótlása kész', 'Újra átnéztem az összes MVM és Flip számlát, és kitöltöttem az üres cellákat:', result, '');
}

/** Scheduled: looks for new MVM bill emails. */
function checkBills() {
  processBills_({ notify: true, query: ' newer_than:30d', includeProcessed: false });
}

/** Scheduled daily: emails a reminder when a reading window opens or closes. */
function checkReadingReminders() {
  var parts = Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyy-M-d').split('-').map(Number);
  var reminders = readingRemindersFor({ year: parts[0], month: parts[1], day: parts[2] });
  var props = PropertiesService.getScriptProperties();
  reminders.forEach(function (r) {
    var key = 'reminder:' + r.utility + ':' + r.start + ':' + r.kind;
    if (props.getProperty(key)) return;
    sendMail_(renderReminderEmail(r));
    props.setProperty(key, new Date().toISOString());
  });
}

function processBills_(options) {
  var label = GmailApp.getUserLabelByName(CONFIG.processedLabel) || GmailApp.createLabel(CONFIG.processedLabel);
  var senders = [];
  Object.keys(BILL_SOURCES).forEach(function (k) { senders = senders.concat(BILL_SOURCES[k].senders); });
  var query = 'from:(' + senders.join(' OR ') + ')' +
    (options.includeProcessed ? '' : ' -label:' + CONFIG.processedLabel) + options.query;

  var result = { written: [], already: [], conflicts: [], otherAddress: 0, unreadable: [] };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var threads = [];
  for (var start = 0; ; start += 50) {
    var page = GmailApp.search(query, start, 50);
    threads = threads.concat(page);
    if (page.length < 50) break;
  }
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) { handleMessage_(ss, msg, result); });
  });
  // Label only after everything was handled, so a failure leaves the emails to retry next run.
  for (var i = 0; i < threads.length; i += 100) label.addToThreads(threads.slice(i, i + 100));

  if (options.notify) notifyBills_(result);
  return result;
}

function handleMessage_(ss, msg, result) {
  var email = {
    from: msg.getFrom(),
    subject: msg.getSubject(),
    body: msg.getPlainBody(),
    attachmentNames: msg.getAttachments().map(function (a) { return a.getName(); })
  };
  var payments = parseFlipPayment(email);
  if (payments) {
    // Payment confirmations only add invoice numbers; they never trigger a "new bill" email.
    payments.forEach(function (p) {
      applyBill_(ss, { utility: 'internet', invoiceNo: p.invoiceNo, amount: p.amount }, p.monthKey, result, true);
    });
    return;
  }
  var bill = parseBillEmail(email);
  if (!bill) return;
  var needsInvoice = !BILL_SOURCES[bill.utility].noInvoice;
  if (!bill.accountId || (needsInvoice && !bill.invoiceNo) || bill.amount === null) {
    result.unreadable.push({ subject: msg.getSubject(), date: Utilities.formatDate(msg.getDate(), CONFIG.timeZone, 'yyyy.MM.dd') });
    return;
  }
  if (bill.accountId !== CONFIG.accounts[bill.utility]) { result.otherAddress++; return; }
  applyBill_(ss, bill, Utilities.formatDate(msg.getDate(), CONFIG.timeZone, 'yyyy.MM'), result, false);
}

function applyBill_(ss, bill, monthKey, result, isPayment) {
  var tab = CONFIG.tabs[bill.utility];
  var sheet = ss.getSheetByName(tab.name);
  var entry = { bill: bill, monthKey: monthKey, tab: tab.name, isPayment: isPayment };
  var plan = planSheetUpdate(sheet.getDataRange().getDisplayValues(), monthKey, tab, bill);

  if (plan.action === 'write') {
    Object.keys(plan.writes).forEach(function (col) {
      sheet.getRange(plan.row, Number(col)).setValue(plan.writes[col]);
    });
    result.written.push(entry);
  } else if (plan.action === 'already') {
    if (!isPayment) result.already.push(entry);
  } else {
    entry.reason = plan.reason;
    result.conflicts.push(entry);
  }
}

function notifyBills_(result) {
  var notify = function (e, written) {
    if (e.isPayment) return;
    var pay = CONFIG.pay[e.bill.utility];
    sendMail_(renderBillEmail({
      utilityName: CONFIG.utilityNames[e.bill.utility],
      amount: e.bill.amount,
      dueDate: e.bill.dueDate,
      invoiceNo: e.bill.invoiceNo,
      tab: e.tab,
      monthKey: e.monthKey,
      written: written
    }, pay.url, pay.label));
  };
  result.written.forEach(function (e) { notify(e, true); });
  // "already" bills were typed in by hand, but this is still the first email about them.
  result.already.forEach(function (e) { notify(e, false); });
  if (result.conflicts.length || result.unreadable.length) {
    sendSummary_('Számlák: ellenőrizd kézzel', 'Új számla érkezett, de nem tudtam automatikusan beírni:', {
      written: [], already: [], conflicts: result.conflicts, unreadable: result.unreadable, otherAddress: 0
    }, '');
  }
}

function sendSummary_(title, intro, result, footer) {
  sendMail_(renderSummaryEmail(title, intro, result, footer));
}

function sendMail_(email) {
  var to = CONFIG.notifyEmail || Session.getEffectiveUser().getEmail();
  var plain = email.html.replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|div|tr|table)>/g, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  MailApp.sendEmail(to, email.subject, plain, { htmlBody: email.html, name: 'Számlák' });
}

/**
 * Helper for building the meter-reading import: converts the newest Fő út 191
 * gas and electricity bill PDFs to text and writes it to the execution log.
 * Needs the Drive advanced service (enabled in appsscript.json).
 */
function logBillPdfText() {
  ['gas', 'electricity'].forEach(function (utility) {
    var src = BILL_SOURCES[utility];
    var threads = GmailApp.search('from:(' + src.senders.join(' OR ') + ') has:attachment', 0, 20);
    for (var i = 0; i < threads.length; i++) {
      var msg = threads[i].getMessages()[0];
      var bill = parseBillEmail({ from: msg.getFrom(), subject: msg.getSubject(), body: msg.getPlainBody(), attachmentNames: [] });
      if (!bill || bill.accountId !== CONFIG.accounts[utility]) continue;
      var pdf = msg.getAttachments().filter(function (a) { return /\.pdf$/i.test(a.getName()); })[0];
      if (!pdf) continue;
      Logger.log('===== ' + utility + ' ' + pdf.getName() + ' =====\n' + pdfToText_(pdf));
      break;
    }
  });
}

function pdfToText_(blob) {
  var file = Drive.Files.create({ name: 'tmp-szamla-ocr', mimeType: 'application/vnd.google-apps.document' }, blob, { ocrLanguage: 'hu' });
  try {
    return DocumentApp.openById(file.id).getBody().getText();
  } finally {
    Drive.Files.remove(file.id);
  }
}
