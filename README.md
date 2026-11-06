# Meter-Submission

Automation for the "Számlák" Google Sheet (Fő út 191). It runs as a Google Apps Script attached to the sheet, so it needs no passwords and works while your PC is off.

What it does:

- **Imports MVM Next bills.** Once a day (around 7:00) it reads new MVM gas and electricity bill emails in Gmail and writes the invoice number and amount into the matching month on the `Gáz` and `Villany` tabs. Bills for other addresses on the same MVM login are skipped. It never overwrites a cell you filled in; if something doesn't match, it emails you instead.
- **Emails you about new bills** (formatted HTML) with the amount, due date and a pay link.
- **Reminds you to submit meter readings.** Gas: 23rd to 26th every month. Electricity: 1st to 7th of February, May, August and November. You get one email when the window opens and one on its last day.

Processed emails get the Gmail label `Szamlak-feldolgozva`.

## Install

1. Open the Számlák sheet, then **Extensions → Apps Script**.
2. In the editor, create the files `Main.gs`, `Parser.gs` and `Emails.gs` and paste in the contents of `apps-script/Main.js`, `apps-script/Parser.js` and `apps-script/Emails.js`. Delete the default `Code.gs`.
3. **Project Settings → Show "appsscript.json" manifest file in editor**, then paste in `apps-script/appsscript.json`.
4. Choose the `setup` function at the top and click **Run**. Approve the access prompt (Gmail, this sheet, sending email, triggers, and Drive/Docs for reading bill PDFs).

`setup` imports past bills without emailing about each one, then sends one summary email. Running it again is safe.

## Other functions you can run

- `backfill`: re-reads every MVM bill email, including ones already processed, and fills cells that are still empty. It never overwrites, so it is safe to run again.
- `logBillPdfText`: converts the newest Fő út 191 gas and electricity bill PDFs to text and prints it in the execution log. It is used to build the meter-reading import.

To change account numbers, tab columns, the reminder windows or the notification address, edit `CONFIG` in `Main.js` and `READING_WINDOWS` in `Parser.js`.

## Development

```
node --test
```

The parsing and sheet logic in `apps-script/Parser.js` has no Google dependencies and is unit tested in `tests/`.
