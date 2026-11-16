/**
 * Számlák automation: imports bills (MVM Next, Flip, One, Díjnet) and water meter readings
 * from Gmail into this sheet, emails you about new bills, and reminds you when a meter reading is due.
 * Which flat this sheet belongs to, and so which accounts and tabs it uses, is set in Config.gs.
 *
 * First time: run `setup` once from the Apps Script editor and approve the access prompt.
 */

/** Run once: installs the schedules and imports past bills without emailing about each one. */
function setup() {
  var cfg = config_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['checkBills', 'checkReadingReminders'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkBills').timeBased().everyDays(1).atHour(7).inTimezone(COMMON.timeZone).create();
  ScriptApp.newTrigger('checkReadingReminders').timeBased().everyDays(1).atHour(8).inTimezone(COMMON.timeZone).create();
  var result = processBills_({ notify: false, query: '', includeProcessed: false });
  sendSummary_('Számlák automatizálás bekapcsolva (' + cfg.name + ')',
    'Az automatikus számlafigyelés be van kapcsolva. Ezeket a régebbi számlákat dolgoztam fel:', result,
    'Mostantól naponta egyszer (reggel 7-kor) ellenőrzöm az új számlákat, és szólok, ha mérőállást kell leadni.');
}

/**
 * Re-reads every bill and reading email, including ones already processed, and fills any cells
 * that are still empty. Never overwrites. Safe to run any time.
 */
function backfill() {
  var result = processBills_({ notify: false, query: '', includeProcessed: true });
  sendSummary_('Számlák: régi számlák pótlása kész (' + config_().name + ')',
    'Újra átnéztem az összes számlát és mérőállás-visszaigazolást, és kitöltöttem az üres cellákat:', result, '');
}

/** Scheduled: looks for new bill and reading emails. */
function checkBills() {
  processBills_({ notify: true, query: ' newer_than:30d', includeProcessed: false });
}

/** Scheduled daily: emails a reminder when a reading window opens or closes. */
function checkReadingReminders() {
  var cfg = config_();
  var parts = Utilities.formatDate(new Date(), COMMON.timeZone, 'yyyy-M-d').split('-').map(Number);
  var today = { year: parts[0], month: parts[1], day: parts[2] };
  var props = PropertiesService.getScriptProperties();
  var reminders = readingRemindersFor(today, cfg.readingWindows)
    .concat(datedRemindersFor(today, storedWaterWindows_(props)));
  reminders.forEach(function (r) {
    var key = 'reminder:' + r.utility + ':' + r.start + ':' + r.kind;
    if (props.getProperty(key)) return;
    sendMail_(renderReminderEmail(r));
    props.setProperty(key, new Date().toISOString());
  });
}

function processBills_(options) {
  var cfg = config_();
  var label = GmailApp.getUserLabelByName(cfg.processedLabel) || GmailApp.createLabel(cfg.processedLabel);
  var senders = [];
  Object.keys(cfg.sources).forEach(function (k) { senders = senders.concat(BILL_SOURCES[k].senders); });
  if (cfg.readings || cfg.waterWindowAddress) senders = senders.concat(READING_SENDERS);
  var query = 'from:(' + senders.join(' OR ') + ')' +
    (options.includeProcessed ? '' : ' -label:' + cfg.processedLabel) + options.query;

  var result = { written: [], already: [], conflicts: [], otherAddress: 0, unreadable: [], readingsWritten: [], readingConflicts: [] };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var threads = [];
  for (var start = 0; ; start += 50) {
    var page = GmailApp.search(query, start, 50);
    threads = threads.concat(page);
    if (page.length < 50) break;
  }
  // Oldest first, so that when two emails disagree the earlier one is in the sheet and the later one is reported.
  var messages = [];
  threads.forEach(function (thread) { messages = messages.concat(thread.getMessages()); });
  messages.sort(function (a, b) { return a.getDate() - b.getDate(); });
  messages.forEach(function (msg) { handleMessage_(ss, cfg, msg, result); });
  // Label only after everything was handled, so a failure leaves the emails to retry next run.
  for (var i = 0; i < threads.length; i += 100) label.addToThreads(threads.slice(i, i + 100));

  if (options.notify) notifyBills_(result);
  return result;
}

function handleMessage_(ss, cfg, msg, result) {
  var email = {
    from: msg.getFrom(),
    subject: msg.getSubject(),
    body: msg.getPlainBody(),
    attachmentNames: msg.getAttachments().map(function (a) { return a.getName(); })
  };
  var emailDate = Utilities.formatDate(msg.getDate(), COMMON.timeZone, 'yyyy.MM.dd');

  var readings = parseMeterReadings(email, emailDate);
  if (readings) {
    if (cfg.readings) readings.forEach(function (r) { applyReading_(ss, cfg, r, result); });
    return;
  }
  var notice = parseWaterWindow(email);
  if (notice) {
    if (cfg.waterWindowAddress && cfg.waterWindowAddress.test(notice.address)) storeWaterWindow_(notice);
    return;
  }
  if (cfg.sources.internet) {
    var payments = parseFlipPayment(email);
    if (payments) {
      // Payment confirmations only add invoice numbers; they never trigger a "new bill" email.
      payments.forEach(function (p) {
        applyBill_(ss, cfg, { utility: 'internet', invoiceNo: p.invoiceNo, amount: p.amount }, p.monthKey, result, true);
      });
      return;
    }
  }
  var bill = parseBillEmail(email);
  if (!bill || !cfg.sources[bill.utility]) return;
  var needsInvoice = !BILL_SOURCES[bill.utility].noInvoice;
  if (!bill.accountId || (needsInvoice && !bill.invoiceNo) || bill.amount === null) {
    result.unreadable.push({ subject: msg.getSubject(), date: emailDate });
    return;
  }
  if (bill.accountId !== cfg.sources[bill.utility].account) { result.otherAddress++; return; }
  applyBill_(ss, cfg, bill, emailDate.slice(0, 7), result, false);
}

function applyBill_(ss, cfg, bill, monthKey, result, isPayment) {
  var src = cfg.sources[bill.utility];
  var sheet = ss.getSheetByName(src.tab);
  var entry = { bill: bill, monthKey: monthKey, tab: src.tab, isPayment: isPayment };
  var plan = planSheetUpdate(sheet.getDataRange().getDisplayValues(), monthKey, src, bill);

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

function applyReading_(ss, cfg, reading, result) {
  var col = cfg.readings.meters[reading.meter];
  if (col === undefined) return;
  var sheet = ss.getSheetByName(cfg.readings.tab);
  var monthKey = reading.date.slice(0, 7);
  var entry = { meter: reading.meter, value: reading.value, date: reading.date, monthKey: monthKey, tab: cfg.readings.tab };
  var plan = planReadingUpdate(sheet.getDataRange().getDisplayValues(), monthKey, col, reading.value);
  if (plan.action === 'write') {
    Object.keys(plan.writes).forEach(function (c) {
      sheet.getRange(plan.row, Number(c)).setValue(plan.writes[c]);
    });
    result.readingsWritten.push(entry);
  } else if (plan.action === 'conflict') {
    entry.reason = plan.reason;
    result.readingConflicts.push(entry);
  }
}

/** Water reading windows announced by Vízművek, kept until they are over. */
function storedWaterWindows_(props) {
  try {
    return JSON.parse(props.getProperty('waterWindows') || '[]');
  } catch (e) {
    return [];
  }
}

function storeWaterWindow_(w) {
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), COMMON.timeZone, 'yyyy.MM.dd');
  var windows = storedWaterWindows_(props).filter(function (x) { return x.end >= today && x.start !== w.start; });
  if (w.end >= today) windows.push({ utility: 'water', name: 'Víz', start: w.start, end: w.end, url: COMMON.waterUrl });
  props.setProperty('waterWindows', JSON.stringify(windows));
}

function notifyBills_(result) {
  var cfg = config_();
  var notify = function (e, written) {
    if (e.isPayment) return;
    var src = cfg.sources[e.bill.utility];
    sendMail_(renderBillEmail({
      utilityName: src.name,
      amount: e.bill.amount,
      dueDate: e.bill.dueDate,
      invoiceNo: e.bill.invoiceNo,
      tab: e.tab,
      monthKey: e.monthKey,
      written: written
    }, src.payUrl, src.payLabel));
  };
  result.written.forEach(function (e) { notify(e, true); });
  // "already" bills were typed in by hand, but this is still the first email about them.
  result.already.forEach(function (e) { notify(e, false); });
  if (result.conflicts.length || result.unreadable.length || result.readingConflicts.length) {
    sendSummary_('Számlák: ellenőrizd kézzel', 'Új számla vagy mérőállás érkezett, de nem tudtam automatikusan beírni:', {
      written: [], already: [], conflicts: result.conflicts, unreadable: result.unreadable, otherAddress: 0,
      readingsWritten: [], readingConflicts: result.readingConflicts
    }, '');
  }
}

function sendSummary_(title, intro, result, footer) {
  sendMail_(renderSummaryEmail(title, intro, result, footer));
}

function sendMail_(email) {
  var to = COMMON.notifyEmail || Session.getEffectiveUser().getEmail();
  var plain = email.html.replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|div|tr|table)>/g, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  MailApp.sendEmail(to, email.subject, plain, { htmlBody: email.html, name: 'Számlák' });
}

/**
 * Helper for building the meter-reading import: converts the newest gas and electricity bill PDFs
 * of this flat to text and writes it to the execution log.
 * Needs the Drive advanced service (enabled in appsscript.json).
 */
function logBillPdfText() {
  var cfg = config_();
  ['gas', 'electricity'].forEach(function (utility) {
    if (!cfg.sources[utility]) return;
    var src = BILL_SOURCES[utility];
    var threads = GmailApp.search('from:(' + src.senders.join(' OR ') + ') has:attachment', 0, 20);
    for (var i = 0; i < threads.length; i++) {
      var msg = threads[i].getMessages()[0];
      var bill = parseBillEmail({ from: msg.getFrom(), subject: msg.getSubject(), body: msg.getPlainBody(), attachmentNames: [] });
      if (!bill || bill.accountId !== cfg.sources[utility].account) continue;
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
