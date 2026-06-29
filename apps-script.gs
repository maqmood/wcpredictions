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

/**
 * GET endpoint — returns every submitted bracket.
 * Called by the "View Picks" tab via JSONP (?callback=...) to avoid CORS.
 * Opening the URL plainly in a browser also returns the JSON.
 */
function doGet(e) {
  var callback = e && e.parameter ? e.parameter.callback : null;
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Brackets') || ss.getSheets()[0];
    var values = sheet.getDataRange().getValues();

    var picks = [];
    for (var i = 1; i < values.length; i++) {   // skip header row
      var r = values[i];
      if (!r[1] && !r[2]) continue;             // skip blank rows
      picks.push({
        timestamp:   r[0] ? new Date(r[0]).toISOString() : '',
        name:        r[1],
        champion:    r[2],
        third_place: r[3],
        r32:         r[4],
        r16:         r[5],
        qf:          r[6],
        sf:          r[7]
      });
    }
    return reply({ result: 'success', count: picks.length, picks: picks }, callback);
  } catch (err) {
    return reply({ result: 'error', error: String(err) }, callback);
  }
}

// Wraps output as JSONP when a callback is given, otherwise plain JSON.
function reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
