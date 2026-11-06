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
    electricity: '2600107389' // Vevő (fizető) azonosító
  },
  tabs: {
    gas: { name: 'Gáz', invoiceCol: 2, amountCol: 3 },          // C = Számla, D = Fizetendő
    electricity: { name: 'Villany', invoiceCol: 1, amountCol: 2 } // B = Számla, C = Fizetendő
  },
  utilityNames: { gas: 'Gáz', electricity: 'Villany' },
  processedLabel: 'Szamlak-feldolgozva',
  // Leave empty to send to the account that owns the script.
  notifyEmail: '',
  mvmUrl: 'https://onlineugyintezes.mvmnext.hu/',
  timeZone: 'Europe/Budapest'
};

/** Run once: installs the schedules and imports past bills without emailing about them. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['checkBills', 'checkReadingReminders'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkBills').timeBased().everyHours(4).create();
  ScriptApp.newTrigger('checkReadingReminders').timeBased().everyDays(1).atHour(8).inTimezone(CONFIG.timeZone).create();
  var result = processBills_({ notify: false, query: '' });
  sendMail_('Számlák automatizálás bekapcsolva',
    'Az automatikus számlafigyelés be van kapcsolva.\n\n' + summarize_(result) +
    '\nMostantól 4 óránként ellenőrzöm az új MVM számlákat, és szólok, ha mérőállást kell diktálni.');
}

/** Scheduled: looks for new MVM bill emails. */
function checkBills() {
  processBills_({ notify: true, query: ' newer_than:30d' });
}

/** Scheduled daily: emails a reminder when a reading window opens or closes. */
function checkReadingReminders() {
  var now = new Date();
  var parts = Utilities.formatDate(now, CONFIG.timeZone, 'yyyy-M-d').split('-').map(Number);
  var reminders = readingRemindersFor({ year: parts[0], month: parts[1], day: parts[2] });
  var props = PropertiesService.getScriptProperties();
  reminders.forEach(function (r) {
    var key = 'reminder:' + r.utility + ':' + r.start + ':' + r.kind;
    if (props.getProperty(key)) return;
    var subject = r.kind === 'opens'
      ? r.name + ' mérőállás diktálás most nyílik (' + r.start + ' – ' + r.end + ')'
      : r.name + ' mérőállás diktálás ma zárul (' + r.end + ')';
    var body = 'Fő út 191: ' + r.name.toLowerCase() + ' mérőállás diktálás ' + r.start + ' és ' + r.end + ' között.\n\n' +
      'Diktálás itt: ' + CONFIG.mvmUrl + '\n\n' +
      'Ha már diktáltál ebben az időszakban, ezt az emlékeztetőt figyelmen kívül hagyhatod.';
    sendMail_(subject, body);
    props.setProperty(key, new Date().toISOString());
  });
}

function processBills_(options) {
  var label = GmailApp.getUserLabelByName(CONFIG.processedLabel) || GmailApp.createLabel(CONFIG.processedLabel);
  var senders = [];
  Object.keys(BILL_SOURCES).forEach(function (k) { senders = senders.concat(BILL_SOURCES[k].senders); });
  var query = 'from:(' + senders.join(' OR ') + ') -label:' + CONFIG.processedLabel.replace(/[\/ ]/g, '-') + options.query;

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
  var bill = parseBillEmail({
    from: msg.getFrom(),
    subject: msg.getSubject(),
    body: msg.getPlainBody(),
    attachmentNames: msg.getAttachments().map(function (a) { return a.getName(); })
  });
  if (!bill) return;
  if (!bill.accountId || !bill.invoiceNo || bill.amount === null) {
    result.unreadable.push({ subject: msg.getSubject(), date: msg.getDate() });
    return;
  }
  if (bill.accountId !== CONFIG.accounts[bill.utility]) { result.otherAddress++; return; }

  var tab = CONFIG.tabs[bill.utility];
  var sheet = ss.getSheetByName(tab.name);
  var monthKey = Utilities.formatDate(msg.getDate(), CONFIG.timeZone, 'yyyy.MM');
  var entry = { bill: bill, monthKey: monthKey, tab: tab.name };
  var plan = planSheetUpdate(sheet.getDataRange().getDisplayValues(), monthKey, tab, bill);

  if (plan.action === 'write') {
    Object.keys(plan.writes).forEach(function (col) {
      sheet.getRange(plan.row, Number(col)).setValue(plan.writes[col]);
    });
    result.written.push(entry);
  } else if (plan.action === 'already') {
    result.already.push(entry);
  } else {
    entry.reason = plan.reason;
    result.conflicts.push(entry);
  }
}

function notifyBills_(result) {
  result.written.concat(result.already).forEach(function (e) {
    // "already" bills were typed in by hand, but this is still the first email about them.
    sendMail_('Új ' + CONFIG.utilityNames[e.bill.utility].toLowerCase() + 'számla: ' + formatFt_(e.bill.amount) +
      ', határidő ' + e.bill.dueDate,
      'Fő út 191, ' + CONFIG.utilityNames[e.bill.utility] + '\n' +
      'Összeg: ' + formatFt_(e.bill.amount) + '\n' +
      'Fizetési határidő: ' + e.bill.dueDate + '\n' +
      'Számlaszám: ' + e.bill.invoiceNo + '\n\n' +
      'Beírva a(z) "' + e.tab + '" fül ' + e.monthKey + ' sorába.\n\n' +
      'Fizetés: ' + CONFIG.mvmUrl);
  });
  if (result.conflicts.length || result.unreadable.length) {
    sendMail_('Számlák: ellenőrizd kézzel', summarize_(result));
  }
}

function summarize_(r) {
  var lines = [];
  lines.push('Beírt számlák: ' + r.written.length);
  r.written.forEach(function (e) { lines.push('  ' + e.tab + ' ' + e.monthKey + ': ' + e.bill.invoiceNo + ', ' + formatFt_(e.bill.amount)); });
  lines.push('Már a táblában: ' + r.already.length);
  lines.push('Másik címhez tartozó számla (kihagyva): ' + r.otherAddress);
  if (r.conflicts.length) {
    lines.push('Nem írtam be, nézd meg kézzel:');
    r.conflicts.forEach(function (e) { lines.push('  ' + e.tab + ': ' + e.reason + ', ' + formatFt_(e.bill.amount) + ', határidő ' + e.bill.dueDate); });
  }
  if (r.unreadable.length) {
    lines.push('Nem tudtam értelmezni:');
    r.unreadable.forEach(function (u) { lines.push('  ' + u.subject + ' (' + u.date + ')'); });
  }
  return lines.join('\n') + '\n';
}

function formatFt_(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Ft';
}

function sendMail_(subject, body) {
  var to = CONFIG.notifyEmail || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, subject, body);
}
