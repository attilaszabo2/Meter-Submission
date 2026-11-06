/**
 * HTML email templates. Pure functions, so they can be tested with Node.
 * Styles are inline because Gmail drops most <style> blocks.
 */

var EMAIL_COLORS = {
  text: '#1f2933',
  muted: '#616e7c',
  border: '#e4e7eb',
  bg: '#f5f7fa',
  accent: '#1f6feb',
  ok: '#1a7f37',
  warn: '#9a6700',
  warnBg: '#fff8c5'
};

function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatFt(n) {
  if (n === null || n === undefined || n === '') return '';
  var neg = n < 0;
  var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '−' : '') + s + ' Ft';
}

function layout_(title, inner, footer) {
  var c = EMAIL_COLORS;
  return '<!doctype html><html><body style="margin:0;padding:0;background:' + c.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + c.bg + ';padding:24px 12px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ' + c.border + ';border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:' + c.text + ';">' +
    '<tr><td style="padding:20px 24px 4px;font-size:13px;color:' + c.muted + ';">Számlák · Fő út 191</td></tr>' +
    '<tr><td style="padding:0 24px 12px;font-size:20px;font-weight:bold;">' + esc_(title) + '</td></tr>' +
    '<tr><td style="padding:0 24px 20px;font-size:14px;line-height:1.5;">' + inner + '</td></tr>' +
    (footer ? '<tr><td style="padding:12px 24px;border-top:1px solid ' + c.border + ';font-size:12px;color:' + c.muted + ';">' + footer + '</td></tr>' : '') +
    '</table></td></tr></table></body></html>';
}

function button_(label, url) {
  return '<a href="' + esc_(url) + '" style="display:inline-block;background:' + EMAIL_COLORS.accent +
    ';color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:bold;font-size:14px;">' + esc_(label) + '</a>';
}

function table_(headers, rows, alignRight) {
  var c = EMAIL_COLORS;
  alignRight = alignRight || [];
  var th = headers.map(function (h, i) {
    return '<th style="text-align:' + (alignRight.indexOf(i) !== -1 ? 'right' : 'left') + ';padding:6px 8px;border-bottom:2px solid ' + c.border +
      ';font-size:12px;color:' + c.muted + ';font-weight:bold;">' + esc_(h) + '</th>';
  }).join('');
  var tr = rows.map(function (r) {
    return '<tr>' + r.map(function (cell, i) {
      return '<td style="text-align:' + (alignRight.indexOf(i) !== -1 ? 'right' : 'left') + ';padding:6px 8px;border-bottom:1px solid ' + c.border +
        ';white-space:nowrap;">' + esc_(cell) + '</td>';
    }).join('') + '</tr>';
  }).join('');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin:8px 0 16px;">' +
    '<tr>' + th + '</tr>' + tr + '</table>';
}

function section_(title, color) {
  return '<div style="margin:16px 0 4px;font-size:15px;font-weight:bold;color:' + (color || EMAIL_COLORS.text) + ';">' + esc_(title) + '</div>';
}

/**
 * Email for one new bill.
 * @param {{utilityName: string, amount: number, dueDate: string, invoiceNo: string, tab: string, monthKey: string, written: boolean}} b
 */
function renderBillEmail(b, mvmUrl) {
  var c = EMAIL_COLORS;
  var subject = 'Új ' + b.utilityName.toLowerCase() + 'számla: ' + formatFt(b.amount).replace(/ /g, ' ') + ', határidő ' + b.dueDate;
  var inner =
    '<div style="font-size:32px;font-weight:bold;margin:4px 0;">' + esc_(formatFt(b.amount)) + '</div>' +
    '<div style="color:' + c.muted + ';margin-bottom:16px;">Fizetési határidő: <b style="color:' + c.text + ';">' + esc_(b.dueDate) + '</b></div>' +
    table_(['Közmű', 'Számlaszám', 'Sor a táblában'], [[b.utilityName, b.invoiceNo, b.tab + ' · ' + b.monthKey]]) +
    '<div style="margin:0 0 16px;color:' + (b.written ? c.ok : c.muted) + ';">' +
    (b.written ? '✓ Beírtam a táblázatba.' : 'Ez a számla már szerepelt a táblázatban.') + '</div>' +
    button_('Fizetés az MVM Next oldalán', mvmUrl);
  return { subject: subject, html: layout_('Új ' + b.utilityName.toLowerCase() + 'számla érkezett', inner, 'Automatikus értesítés a Számlák táblázatból.') };
}

/**
 * Meter-reading reminder.
 * @param {{name: string, kind: string, start: string, end: string}} r
 */
function renderReminderEmail(r, mvmUrl) {
  var opens = r.kind === 'opens';
  var subject = opens
    ? r.name + ' mérőállás diktálás most nyílik (' + r.start + ' – ' + r.end + ')'
    : r.name + ' mérőállás diktálás ma zárul (' + r.end + ')';
  var inner =
    '<p style="margin:0 0 12px;">' + (opens ? 'Megnyílt a diktálási időszak.' : '<b>Ma van az utolsó nap</b> a diktálásra.') + '</p>' +
    table_(['Közmű', 'Időszak'], [[r.name, r.start + ' – ' + r.end]]) +
    '<p style="margin:0 0 16px;">Olvasd le a mérőórát, és add meg az állást az MVM Next oldalán.</p>' +
    button_('Mérőállás diktálása', mvmUrl);
  return {
    subject: subject,
    html: layout_(r.name + ' mérőállás diktálás', inner, 'Ha már diktáltál ebben az időszakban, ezt az emlékeztetőt figyelmen kívül hagyhatod.')
  };
}

/**
 * Summary of an import run (setup, backfill, or problems found by a scheduled run).
 * Dates in result entries must already be strings.
 */
function renderSummaryEmail(title, intro, r, footer) {
  var c = EMAIL_COLORS;
  var inner = intro ? '<p style="margin:0 0 12px;">' + esc_(intro) + '</p>' : '';

  var stat = function (label, value, color) {
    return '<td style="padding:8px 12px;background:' + c.bg + ';border-radius:6px;text-align:center;">' +
      '<div style="font-size:22px;font-weight:bold;color:' + (color || c.text) + ';">' + value + '</div>' +
      '<div style="font-size:12px;color:' + c.muted + ';">' + esc_(label) + '</div></td>';
  };
  var gap = '<td style="width:8px;"></td>';
  inner += '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 8px;"><tr>' +
    stat('beírva', r.written.length, c.ok) + gap +
    stat('már a táblában', r.already.length) + gap +
    stat('nézd meg', r.conflicts.length + r.unreadable.length, (r.conflicts.length + r.unreadable.length) ? c.warn : c.text) + gap +
    stat('más címhez', r.otherAddress) +
    '</tr></table>';

  if (r.written.length) {
    inner += section_('Beírt számlák', c.ok);
    inner += table_(['Hónap', 'Közmű', 'Számlaszám', 'Összeg'],
      r.written.map(function (e) { return [e.monthKey, e.tab, e.bill.invoiceNo, formatFt(e.bill.amount)]; }), [3]);
  }
  if (r.conflicts.length) {
    inner += section_('Nem írtam be, nézd meg kézzel', c.warn);
    inner += '<div style="font-size:12px;color:' + c.muted + ';">Az adott hónapban már van más érték. Ezek többnyire helyesbítő vagy jóváíró számlák.</div>';
    inner += table_(['Hónap', 'Közmű', 'Számlaszám', 'Összeg', 'A táblában most'],
      r.conflicts.map(function (e) { return [e.monthKey, e.tab, e.bill.invoiceNo, formatFt(e.bill.amount), e.reason]; }), [3]);
  }
  if (r.unreadable.length) {
    inner += section_('Nem tudtam értelmezni', c.warn);
    inner += table_(['Dátum', 'Tárgy'], r.unreadable.map(function (u) { return [u.date, u.subject]; }));
  }
  return { subject: title, html: layout_(title, inner, footer || '') };
}

if (typeof module !== 'undefined') {
  module.exports = { renderBillEmail: renderBillEmail, renderReminderEmail: renderReminderEmail, renderSummaryEmail: renderSummaryEmail, formatFt: formatFt };
}
