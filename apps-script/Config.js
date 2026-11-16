/**
 * Per-flat settings. The same code is pasted into each flat's Számlák sheet; the script picks
 * the settings by the id of the sheet it is attached to.
 *
 * sources: which bill emails go into this sheet, the account number that belongs to this flat,
 *   and the tab and zero-based columns to write (A = 0).
 * readings: water meter serial numbers -> zero-based column on the readings tab.
 * waterWindowAddress: Vízművek reading-window notices whose address matches get a last-day reminder.
 */
var MVM_URL = 'https://onlineugyintezes.mvmnext.hu/';

// A function rather than a plain object: Apps Script runs files in an order you can't rely on,
// and this refers to READING_WINDOWS and ALL_MONTHS from Parser.gs.
function properties_() {
  return {
  // Fő út 191, 2220 Vecsés
  '1Mhx9MLphBqSRcJ0Utqz15WoCBnHPxYYoQQMJ8xlpRRA': {
    name: 'Fő út 191',
    processedLabel: 'Szamlak-feldolgozva',
    sources: {
      gas: { account: '30830774', tab: 'Gáz', invoiceCol: 2, amountCol: 3, name: 'Gáz', payUrl: MVM_URL, payLabel: 'Fizetés az MVM Next oldalán' },
      electricity: { account: '2600107389', tab: 'Villany', invoiceCol: 1, amountCol: 2, name: 'Villany', payUrl: MVM_URL, payLabel: 'Fizetés az MVM Next oldalán' },
      internet: { account: '740732742', tab: 'Internet', invoiceCol: 1, amountCol: 2, name: 'Internet', payUrl: 'https://www.flip.hu/myflip/ugyfelszolgalat/kezdo', payLabel: 'Fizetés a Flip oldalán' }
    },
    readingWindows: READING_WINDOWS,
    readings: null,
    waterWindowAddress: null
  },

  // Babér utca 35 II/15, 1131 Budapest
  '1qAJjk1ZCJ7At-i-YxkhQYMA-wfsu0jHmyqRtf6uMyPQ': {
    name: 'Babér utca 35',
    processedLabel: 'Szamlak-Baber-feldolgozva',
    sources: {
      // Flat-rate gas (no meter), billed quarterly.
      gas: { account: '5100472281', tab: 'Gáz', invoiceCol: 1, amountCol: 2, name: 'Gáz', payUrl: MVM_URL, payLabel: 'Fizetés az MVM Next oldalán' },
      electricity: { account: '2602900993', tab: 'Villany', invoiceCol: 1, amountCol: 2, name: 'Villany', payUrl: MVM_URL, payLabel: 'Fizetés az MVM Next oldalán' },
      dijnet: { account: '545817121', tab: 'Dijnet', invoiceCol: 1, amountCol: 2, name: 'Díjnet', payUrl: 'https://www.dijnet.hu/', payLabel: 'Fizetés a Díjneten' },
      one: { account: '2007228555', tab: 'Internet', invoiceCol: 1, amountCol: 2, name: 'Internet (One)', payUrl: 'https://www.one.hu/one-fiok/szamlaim/', payLabel: 'Fizetés a One oldalán' }
    },
    readingWindows: [
      // Electricity can be submitted every month on the 22nd-28th (printed on the bill).
      { utility: 'electricity', name: 'Villany', months: ALL_MONTHS, startDay: 22, endDay: 28, url: MVM_URL }
    ],
    readings: {
      tab: 'Viz',
      meters: { K2407689500010370: 1, K2407689400004030: 2 } // B = meleg, C = hideg
    },
    waterWindowAddress: /Babér/i
  }
  };
}

var COMMON = {
  // Leave empty to send to the account that owns the script.
  notifyEmail: '',
  timeZone: 'Europe/Budapest',
  waterUrl: 'https://ugyfelszolgalat.vizmuvek.hu'
};

var config_cache_ = null;

/** Settings for the sheet this script is attached to. */
function config_() {
  if (config_cache_) return config_cache_;
  var id = SpreadsheetApp.getActiveSpreadsheet().getId();
  var p = properties_()[id];
  if (!p) throw new Error('Ehhez a táblázathoz (' + id + ') nincs beállítás a Config.gs properties_ részében.');
  EMAIL_HEADER = 'Számlák · ' + p.name;
  config_cache_ = p;
  return p;
}
