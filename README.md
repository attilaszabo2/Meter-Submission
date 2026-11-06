# Meter-Submission

Automation for the "Számlák" Google Sheet (Fő út 191). It runs as a Google Apps Script attached to the sheet, so it needs no passwords and works while your PC is off.

What it does:

- **Imports MVM Next bills.** Every 4 hours it reads new MVM gas and electricity bill emails in Gmail and writes the invoice number and amount into the matching month on the `Gáz` and `Villany` tabs. Bills for other addresses on the same MVM login are skipped. It never overwrites a cell you filled in; if something doesn't match, it emails you instead.
- **Emails you about new bills** with the amount and due date.
- **Reminds you to submit meter readings.** Gas: 23rd to 26th every month. Electricity: 1st to 7th of February, May, August and November. You get one email when the window opens and one on its last day.

Processed emails get the Gmail label `Szamlak-feldolgozva`.

## Install

1. Open the Számlák sheet, then **Extensions → Apps Script**.
2. In the editor, create the files `Parser.gs` and `Main.gs` and paste in the contents of `apps-script/Parser.js` and `apps-script/Main.js`. Delete the default `Code.gs`.
3. **Project Settings → Show "appsscript.json" manifest file in editor**, then paste in `apps-script/appsscript.json`.
4. Choose the `setup` function at the top and click **Run**. Approve the access prompt (Gmail, this sheet, sending email, triggers).

`setup` imports past bills without emailing about each one, then sends one summary email. Running it again is safe.

To change account numbers, tab columns, the reminder windows or the notification address, edit `CONFIG` in `Main.js` and `READING_WINDOWS` in `Parser.js`.

## Development

```
node --test
```

The parsing and sheet logic in `apps-script/Parser.js` has no Google dependencies and is unit tested in `tests/`.
