/**
 * SBS Majlis WC26 Predictor — Google Sheets backend
 *
 *  doPost           — save a submitted bracket (from the site)
 *  doGet            — return all brackets + current fixtures (kickoffs + results)
 *  updateFixtures   — pull WC results/kickoffs from football-data.org and cache
 *                     them. Runs automatically once a day at 06:00 GST.
 *  installDailyTrigger — run this ONCE (from the editor) to schedule the daily
 *                     6am fetch and do an immediate first pull.
 *  previewApi       — debug helper: logs the raw team names / stages the API
 *                     returns, so team-name mismatches can be fixed.
 *
 * SETUP
 * 1. Extensions → Apps Script, paste this whole file in.
 * 2. Get a free token at https://www.football-data.org/client/register and
 *    paste it into FOOTBALL_DATA_TOKEN below.
 * 3. Run `installDailyTrigger` once (pick it in the toolbar → Run), authorize.
 * 4. Deploy → Manage deployments → Edit → New version → Deploy (keeps the URL).
 */

// ── CONFIG ────────────────────────────────────────────────────────
var FOOTBALL_DATA_TOKEN = 'PASTE_YOUR_FOOTBALL_DATA_ORG_TOKEN';
var WC_CODE = 'WC';          // football-data competition code for the World Cup
var TZ      = 'Asia/Dubai';  // GST (UTC+4)

// R32 matchups — MUST match the site's TEAMS array exactly (labels incl. flags),
// in the same order.
var TEAMS = [
  ['🇿🇦 South Africa',  '🇨🇦 Canada'],
  ['🇳🇱 Netherlands',   '🇲🇦 Morocco'],
  ['🇩🇪 Germany',       '🇵🇾 Paraguay'],
  ['🇫🇷 France',        '🇸🇪 Sweden'],
  ['🇧🇪 Belgium',       '🇸🇳 Senegal'],
  ['🇺🇸 United States', '🇧🇦 Bosnia'],
  ['🇪🇸 Spain',         '🇦🇹 Austria'],
  ['🇵🇹 Portugal',      '🇭🇷 Croatia'],
  ['🇧🇷 Brazil',        '🇯🇵 Japan'],
  ['🇨🇮 Ivory Coast',   '🇳🇴 Norway'],
  ['🇲🇽 Mexico',        '🇪🇨 Ecuador'],
  ['🏴󠁧󠁢󠁥󠁮󠁧󠁿 England',      '🇨🇩 DR Congo'],
  ['🇨🇭 Switzerland',   '🇩🇿 Algeria'],
  ['🇨🇴 Colombia',      '🇬🇭 Ghana'],
  ['🇦🇺 Australia',     '🇪🇬 Egypt'],
  ['🇦🇷 Argentina',     '🇨🇻 Cape Verde'],
];

// When football-data spells a team differently from us, map its normalized name
// to ours. Left side = normalized API name, right side = normalized our name.
// (Add more here if previewApi() shows an unmatched team.)
var TEAM_ALIASES = {
  'united states of america': 'united states',
  'usa': 'united states',
  'cote divoire': 'ivory coast',
  'cabo verde': 'cape verde',
  'congo dr': 'dr congo',
  'democratic republic of congo': 'dr congo',
  'bosnia and herzegovina': 'bosnia',
};

// ── Team-name normalization ───────────────────────────────────────
function normName(s) {
  return String(s || '')
    // strip flag/emoji/ZWJ/variation-selectors/tag chars
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}️‍\u{E0000}-\u{E007F}]/gu, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function canon(s) { var n = normName(s); return TEAM_ALIASES[n] || n; }

// ── Fetch WC matches from football-data.org ───────────────────────
function fetchWCMatches() {
  if (!FOOTBALL_DATA_TOKEN || FOOTBALL_DATA_TOKEN.indexOf('PASTE_') === 0) {
    throw new Error('Set FOOTBALL_DATA_TOKEN first.');
  }
  var res = UrlFetchApp.fetch(
    'https://api.football-data.org/v4/competitions/' + WC_CODE + '/matches',
    { headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }, muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    throw new Error('football-data ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText()).matches || [];
}

// key: sorted "teamA|teamB" (canonical) → { home, away, winnerCanon, utcDate, status }
function buildApiMap(matches) {
  var map = {};
  matches.forEach(function (m) {
    var h = m.homeTeam && m.homeTeam.name;
    var a = m.awayTeam && m.awayTeam.name;
    if (!h || !a) return;                 // unresolved TBD fixture
    var ch = canon(h), ca = canon(a);
    var winnerCanon = null;
    if (m.status === 'FINISHED' && m.score) {
      if (m.score.winner === 'HOME_TEAM') winnerCanon = ch;
      else if (m.score.winner === 'AWAY_TEAM') winnerCanon = ca;
    }
    map[[ch, ca].sort().join('|')] = {
      home: ch, away: ca, winnerCanon: winnerCanon, utcDate: m.utcDate || null, status: m.status,
    };
  });
  return map;
}

// Walk the bracket, matching each slot's two teams to an API fixture, to derive
// per-slot kickoff + winner label. Mirrors the site's SCHEDULE shape.
function computeFixtures() {
  var api = buildApiMap(fetchWCMatches());
  var sizes = [16, 8, 4, 2, 1];

  var O = sizes.map(function (n) { return []; });
  for (var m = 0; m < 16; m++) O[0][m] = { t1: TEAMS[m][0], t2: TEAMS[m][1] };
  for (var r = 1; r <= 4; r++) for (var i = 0; i < sizes[r]; i++) O[r][i] = { t1: null, t2: null };

  var out = {
    r32:   [], r16: [], qf: [], sf: [],
    final: [{ ko: null, result: null }],
    third: { ko: null, result: null },
  };
  var keyName = ['r32', 'r16', 'qf', 'sf'];
  var loserSF = [null, null];

  for (var rr = 0; rr <= 4; rr++) {
    for (var mm = 0; mm < O[rr].length; mm++) {
      var t1 = O[rr][mm].t1, t2 = O[rr][mm].t2;
      var ko = null, result = null;
      if (t1 && t2) {
        var info = api[[canon(t1), canon(t2)].sort().join('|')];
        if (info) {
          ko = info.utcDate;
          if (info.winnerCanon) result = (canon(t1) === info.winnerCanon) ? t1 : t2;
        }
      }
      var slot = { ko: ko, result: result };
      if (rr < 4) out[keyName[rr]][mm] = slot; else out.final[0] = slot;

      if (result && rr < 4) {                     // advance winner
        var nm = Math.floor(mm / 2);
        if (mm % 2 === 0) O[rr + 1][nm].t1 = result; else O[rr + 1][nm].t2 = result;
      }
      if (rr === 3 && result) loserSF[mm] = (result === t1) ? t2 : t1;  // SF losers
    }
  }

  if (loserSF[0] && loserSF[1]) {
    var ti = api[[canon(loserSF[0]), canon(loserSF[1])].sort().join('|')];
    if (ti) {
      out.third.ko = ti.utcDate;
      if (ti.winnerCanon) out.third.result = (canon(loserSF[0]) === ti.winnerCanon) ? loserSF[0] : loserSF[1];
    }
  }
  return out;
}

// Trigger target — pull fixtures and cache them for the site.
function updateFixtures() {
  var fixtures = computeFixtures();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('FIXTURES', JSON.stringify(fixtures));
  props.setProperty('FIXTURES_UPDATED', new Date().toISOString());
  return fixtures;
}

// Run ONCE from the editor: schedules the daily 6am-GST pull + pulls immediately.
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'updateFixtures') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('updateFixtures')
    .timeBased().atHour(6).everyDays(1).inTimezone(TZ).create();
  return updateFixtures();
}

// Debug: see exactly what the API returns so aliases can be fixed.
function previewApi() {
  var rows = fetchWCMatches().map(function (m) {
    return [m.stage, m.status,
            m.homeTeam && m.homeTeam.name, m.awayTeam && m.awayTeam.name,
            m.score && m.score.winner, m.utcDate];
  });
  Logger.log(JSON.stringify(rows, null, 2));
  return rows;
}

// ── Web endpoints ─────────────────────────────────────────────────
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Brackets') || ss.getSheets()[0];

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
      d.name || '', d.champion || '', d.third_place || '',
      d.r32 || '', d.r16 || '', d.qf || '', d.sf || ''
    ]);

    return ContentService.createTextOutput(JSON.stringify({ result: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ result: 'error', error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function readPicks() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Brackets') || ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  var picks = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[1] && !r[2]) continue;
    picks.push({
      timestamp: r[0] ? new Date(r[0]).toISOString() : '',
      name: r[1], champion: r[2], third_place: r[3],
      r32: r[4], r16: r[5], qf: r[6], sf: r[7]
    });
  }
  return picks;
}

/**
 * GET — returns all brackets + cached fixtures. Called via JSONP (?callback=)
 * to avoid CORS. Opening the URL plainly also returns the JSON.
 */
function doGet(e) {
  var callback = e && e.parameter ? e.parameter.callback : null;
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('FIXTURES');
    var picks = readPicks();
    return reply({
      result: 'success',
      count: picks.length,
      picks: picks,
      fixtures: raw ? JSON.parse(raw) : null,
    }, callback);
  } catch (err) {
    return reply({ result: 'error', error: String(err) }, callback);
  }
}

// Wraps output as JSONP when a callback is given, otherwise plain JSON.
function reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
