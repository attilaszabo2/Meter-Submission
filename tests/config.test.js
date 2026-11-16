const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads the Apps Script files into one shared scope, the way Apps Script does.
function loadScripts() {
  const ctx = vm.createContext({});
  for (const f of ['Parser.js', 'Emails.js', 'Config.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

test('every flat uses known sources with distinct labels', () => {
  const ctx = loadScripts();
  const props = vm.runInContext('properties_()', ctx);
  const sources = vm.runInContext('BILL_SOURCES', ctx);
  const labels = new Set();
  for (const [id, p] of Object.entries(props)) {
    assert.ok(p.name, id);
    for (const [key, src] of Object.entries(p.sources)) {
      assert.ok(sources[key], `${p.name}: unknown source ${key}`);
      assert.match(src.account, /^\d+$/);
      assert.ok(src.tab && Number.isInteger(src.invoiceCol) && Number.isInteger(src.amountCol));
    }
    assert.ok(Array.isArray(p.readingWindows));
    assert.ok(!labels.has(p.processedLabel), 'labels must differ so each sheet sees every email');
    labels.add(p.processedLabel);
  }
  assert.strictEqual(Object.keys(props).length, 2);
});

test('email header shows the flat chosen by config_()', () => {
  const ctx = loadScripts();
  ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getId: () => '1qAJjk1ZCJ7At-i-YxkhQYMA-wfsu0jHmyqRtf6uMyPQ' }) };
  vm.runInContext('config_()', ctx);
  const html = vm.runInContext("renderSummaryEmail('t', '', { written: [], already: [], conflicts: [], unreadable: [], otherAddress: 0 }, '').html", ctx);
  assert.match(html, /Számlák · Babér utca 35/);
  assert.doesNotMatch(html, /Fő út 191/);
});
