/************************************************************************
 * Pine & Co — 웨이팅 시트 웹훅 (Apps Script)
 * ---------------------------------------------------------------------
 * server.js 의 logWaitingEvent() 가 모든 웨이팅 결말(들어옴/취소/노쇼)을
 * 이 스크립트로 POST 한다. 이 스크립트는 들어온 행을 3개 탭으로 분기하고,
 * 대기시간·요일·시간·영업일을 계산해 채운다.
 *
 *   · 웨이팅전체   — 모든 팀 (원장)
 *   · 안온손님     — 취소 + 노쇼 (재연락용 명단, 전화·이메일 포함)
 *   · 들어온손님   — 실제 입장한 팀
 *   · 월간통계     — refreshStats() 로 자동 집계 (메뉴 또는 트리거)
 *
 * 배포:
 *   1) 시트 열고 확장 프로그램 > Apps Script
 *   2) 이 코드 전체 붙여넣기 (기존 doPost 대체)
 *   3) 배포 > 배포 관리 > 기존 웹앱 편집 > 버전 "새 버전" > 배포
 *      (웹앱 URL 은 그대로 유지되므로 server.js SHEETS_WEBHOOK 안 바꿔도 됨)
 *   4) 액세스 권한: "모든 사용자" (server 가 익명 POST)
 ************************************************************************/

var SHEETS = {
  ALL:     '웨이팅전체',
  NOSHOW:  '안온손님',
  IN:      '들어온손님',
  STATS:   '월간통계',
};

var HEADERS = ['기록시각','영업일','요일','등록시각','대기(분)','번호','이름','인원','전화','이메일','결과','구분','좌석'];

// outcome → 한글 라벨 + 구분(통계용 대분류)
var OUTCOME_MAP = {
  checked_in:     { label: '들어옴',     group: '들어옴' },
  cancelled:      { label: '취소',       group: '취소'   },
  declined:       { label: '취소(거절)', group: '취소'   },
  auto_cancelled: { label: '노쇼',       group: '노쇼'   },
};

var WEEKDAYS = ['일','월','화','수','목','금','토'];
// 영업시간(19시~새벽1시) 순서로 히트맵 컬럼 고정
var HOUR_COLS = [19, 20, 21, 22, 23, 0, 1];

/* ── 서버가 POST 하는 진입점 ───────────────────────────────────── */
function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    var row = buildRow(d);

    appendRow(SHEETS.ALL, row);
    var grp = (OUTCOME_MAP[d.outcome] || {}).group;
    if (grp === '들어옴') appendRow(SHEETS.IN, row);
    else                 appendRow(SHEETS.NOSHOW, row);   // 취소 + 노쇼 = 안온손님

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// 브라우저에서 URL 열었을 때 확인용
function doGet() { return json({ ok: true, msg: 'Pine waiting webhook alive' }); }

/* ── 한 건을 시트 한 줄로 변환 ─────────────────────────────────── */
function buildRow(d) {
  var joinedAt    = Number(d.joinedAt)    || 0;
  var calledAt    = Number(d.calledAt)    || 0;
  var completedAt = Number(d.completedAt) || Date.now();

  // 대기(분): 등록 → (호출시각 있으면 호출, 없으면 종료)
  var endMs  = calledAt > 0 ? calledAt : completedAt;
  var waitMin = joinedAt > 0 ? Math.max(0, Math.round((endMs - joinedAt) / 60000)) : '';

  var jk = kst(joinedAt || completedAt);      // 등록 시각(KST)
  var biz = businessDate(jk);                 // 영업일 (새벽 join 은 전날로)
  var om = OUTCOME_MAP[d.outcome] || { label: d.outcome || '', group: '' };

  return [
    fmtDateTime(kst(completedAt)),            // 기록시각
    biz.dateStr,                              // 영업일
    WEEKDAYS[biz.weekday],                    // 요일
    fmtTime(jk),                              // 등록시각
    waitMin,                                  // 대기(분)
    d.number || '',                           // 번호
    d.name || '',                             // 이름
    d.partySize || '',                        // 인원
    "'" + (d.phone || ''),                    // 전화 (앞 0 보존)
    d.email || '',                            // 이메일
    om.label,                                 // 결과
    om.group,                                 // 구분
    d.assignedSeat || '',                     // 좌석
  ];
}

/* ── 월간 통계 재집계 (메뉴/트리거에서 호출) ───────────────────── */
function refreshStats() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var all = ss.getSheetByName(SHEETS.ALL);
  if (!all || all.getLastRow() < 2) { SpreadsheetApp.getUi().alert('데이터가 아직 없어요.'); return; }

  var data = all.getRange(2, 1, all.getLastRow() - 1, HEADERS.length).getValues();

  // 월별 집계 + 요일 카운트 + 요일×시간 히트맵
  var months = {};                 // 'YYYY-MM' → {total,in,cancel,noshow}
  var heat = {};                   // weekday(0-6) → {hour → count}
  var dowCount = [0,0,0,0,0,0,0];  // 요일별 전체 팀수

  data.forEach(function (r) {
    var biz = String(r[1] || '');           // 영업일 YYYY-MM-DD
    var dow = WEEKDAYS.indexOf(String(r[2]));
    var reg = String(r[3] || '');           // 등록시각 HH:MM
    var grp = String(r[11] || '');          // 구분
    if (biz.length < 7) return;

    var ym = biz.slice(0, 7);
    var m = months[ym] || (months[ym] = { total: 0, inn: 0, cancel: 0, noshow: 0 });
    m.total++;
    if (grp === '들어옴') m.inn++;
    else if (grp === '취소') m.cancel++;
    else if (grp === '노쇼') m.noshow++;

    if (dow >= 0) {
      dowCount[dow]++;
      var hr = parseInt(reg.split(':')[0], 10);
      if (!isNaN(hr)) {
        heat[dow] = heat[dow] || {};
        heat[dow][hr] = (heat[dow][hr] || 0) + 1;
      }
    }
  });

  // ── 월간통계 탭 그리기 ──
  var s = ss.getSheetByName(SHEETS.STATS) || ss.insertSheet(SHEETS.STATS);
  s.clear();
  var out = [];
  out.push(['월간 통계  (마지막 갱신: ' + fmtDateTime(kst(Date.now())) + ')']);
  out.push([]);
  out.push(['월', '전체팀', '들어옴', '취소', '노쇼', '입장률', '취소+노쇼율']);
  Object.keys(months).sort().forEach(function (ym) {
    var m = months[ym];
    out.push([
      ym, m.total, m.inn, m.cancel, m.noshow,
      m.total ? Math.round(m.inn / m.total * 100) + '%' : '-',
      m.total ? Math.round((m.cancel + m.noshow) / m.total * 100) + '%' : '-',
    ]);
  });

  out.push([]);
  var busiest = dowCount.indexOf(Math.max.apply(null, dowCount));
  out.push(['가장 바쁜 요일', WEEKDAYS[busiest] + '요일 (' + dowCount[busiest] + '팀)']);
  out.push([]);

  // ── 요일 × 시간대 히트맵 (등록시각 기준, 얼마나 밀렸나) ──
  out.push(['요일 × 시간대 히트맵 (등록 팀수)']);
  out.push(['요일'].concat(HOUR_COLS.map(function (h) { return h + '시'; })).concat(['합계']));
  for (var dw = 0; dw < 7; dw++) {
    var rowArr = [WEEKDAYS[dw] + '요일'];
    var sum = 0;
    HOUR_COLS.forEach(function (h) {
      var c = (heat[dw] && heat[dw][h]) || 0;
      rowArr.push(c || '');
      sum += c;
    });
    rowArr.push(sum || '');
    out.push(rowArr);
  }

  // 가로폭 통일해서 한 번에 기록
  var width = out.reduce(function (w, r) { return Math.max(w, r.length); }, 1);
  out = out.map(function (r) { while (r.length < width) r.push(''); return r; });
  s.getRange(1, 1, out.length, width).setValues(out);
  s.getRange(3, 1, 1, 7).setFontWeight('bold');
  s.setFrozenRows(1);
}

/* ── 시트 열 때 메뉴 추가 ─────────────────────────────────────── */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('웨이팅 통계')
    .addItem('통계 새로고침', 'refreshStats')
    .addToUi();
}

/* ── 유틸 ─────────────────────────────────────────────────────── */
function appendRow(name, row) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.appendRow(row);
}

// ms(UTC) → KST Date 객체(로컬처럼 다루기 위해 +9h 한 값)
function kst(ms) { return new Date(Number(ms) + 9 * 3600 * 1000); }

// 영업일: 새벽 0~5시 join 은 전날 밤 영업으로 귀속
function businessDate(kstDate) {
  var d = new Date(kstDate.getTime());
  if (d.getUTCHours() < 6) d.setUTCDate(d.getUTCDate() - 1);
  return {
    dateStr: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
    weekday: d.getUTCDay(),
  };
}

function fmtDateTime(k) {
  return k.getUTCFullYear() + '-' + pad(k.getUTCMonth() + 1) + '-' + pad(k.getUTCDate())
    + ' ' + pad(k.getUTCHours()) + ':' + pad(k.getUTCMinutes());
}
function fmtTime(k) { return pad(k.getUTCHours()) + ':' + pad(k.getUTCMinutes()); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
