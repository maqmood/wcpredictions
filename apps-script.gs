/**
 * SBS Majlis WC26 Predictor — Google Sheets backend
 *
 * SETUP:
 * 1. Open your Google Sheet → Extensions → Apps Script
 * 2. Delete any existing code, paste this whole file in
 * 3. Click Deploy → New deployment → type "Web app"
 *      - Execute as:  Me
 *      - Who has access:  Anyone
 * 4. Authorize when prompted, copy the /exec URL
 *    (already wired into index.html if it matches your deployment)
 * 5. Re-deploy as a NEW version each time you change this script
 */

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000); // avoid two submissions writing the same row

  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Brackets') || ss.getSheets()[0];

    // Write header row once
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'Timestamp', 'Name', 'Champion', 'Third-Place Play-off',
        'Round of 32', 'Round of 16', 'Quarterfinals', 'Semifinals'
      ]);
      sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    var d = JSON.parse(e.postData.contents);

    sheet.appendRow([
      d.timestamp ? new Date(d.timestamp) : new Date(),
      d.name        || '',
      d.champion    || '',
      d.third_place || '',
      d.r32         || '',
      d.r16         || '',
      d.qf          || '',
      d.sf          || ''
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ result: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Lets you open the /exec URL in a browser to confirm it's live
function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'SBS Majlis WC26 Predictor backend is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}
