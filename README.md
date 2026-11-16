# Meter-Submission

Automation for the "Számlák" Google Sheets of two flats: Fő út 191 (Vecsés) and Babér utca 35 (Budapest). It runs as a Google Apps Script attached to each sheet, so it needs no passwords and works while your PC is off.

The same code goes into both sheets. `apps-script/Config.js` holds the settings of each flat (account numbers, tabs, reminders), and the script picks them by the id of the sheet it is attached to.

What it does for Fő út 191:

- **Imports MVM Next bills.** Once a day (around 7:00) it reads new MVM gas and electricity bill emails in Gmail and writes the invoice number and amount into the matching month on the `Gáz` and `Villany` tabs. Bills for other addresses on the same MVM login are skipped. It never overwrites a cell you filled in; if something doesn't match, it emails you instead.
- **Imports Flip internet bills.** The Flip bill notice gives the amount for the `Internet` tab; the invoice number is added once the "Sikeres fizetés" payment email arrives.
- **Emails you about new bills** (formatted HTML) with the amount, due date and a pay link.
- **Reminds you to submit meter readings.** Gas: 23rd to 26th every month. Electricity: 1st to 7th of February, May, August and November. You get one email when the window opens and one on its last day. Water (submitted by hand): one reminder on the 1st of every month.

Processed emails get the Gmail label `Szamlak-feldolgozva`.

What it does for Babér utca 35:

- **Imports bills** into the matching month: MVM gas (flat-rate, quarterly) and electricity into `Gáz` and `Villany`, the monthly Díjnet bill (Díjbeszedő) into `Dijnet`, and the One internet bill into `Internet` (One's email has no invoice number, so only the amount is filled in). Bills for the other addresses on the same MVM login are skipped.
- **Imports water meter readings** from the Vízművek and Díjnet confirmation emails into `Viz` (B = hot, C = cold), in the month of the reading. If two confirmations disagree for the same month, the first one stays and you get an email about the other.
- **Reminds you to submit readings.** Electricity: 22nd to 28th of every month. Water: on the last day of each window Vízművek announces by email.

Processed emails get the label `Szamlak-Baber-feldolgozva`. Each sheet has its own label, so both sheets see every email.

## Install

1. Open the flat's Számlák sheet, then **Extensions → Apps Script**.
2. In the editor, create the files `Main.gs`, `Parser.gs`, `Emails.gs` and `Config.gs` and paste in the contents of `apps-script/Main.js`, `apps-script/Parser.js`, `apps-script/Emails.js` and `apps-script/Config.js`. Delete the default `Code.gs`.
3. **Project Settings → Show "appsscript.json" manifest file in editor**, then paste in `apps-script/appsscript.json`.
4. Choose the `setup` function at the top and click **Run**. Approve the access prompt (Gmail, this sheet, sending email, triggers, and Drive/Docs for reading bill PDFs).

`setup` imports past bills (and, for Babér, water readings) without emailing about each one, then sends one summary email. Running it again is safe. Do the steps once in each sheet; when the code changes, paste the new files into both.

## Other functions you can run

- `backfill`: re-reads every bill and reading email, including ones already processed, and fills cells that are still empty. It never overwrites, so it is safe to run again.
- `logBillPdfText`: converts the newest gas and electricity bill PDFs of the flat to text and prints it in the execution log. It is used to build the meter-reading import.

To change account numbers, tab columns, the reminder windows or the notification address, edit `apps-script/Config.js` (Fő út 191's reminder windows are `READING_WINDOWS` in `Parser.js`).

## Development

```
node --test
```

The parsing and sheet logic in `apps-script/Parser.js` has no Google dependencies and is unit tested in `tests/`.
