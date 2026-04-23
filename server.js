const express = require('express');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  PORT: process.env.PORT || 3001,
  STAFF_PIN: process.env.STAFF_PIN || '1234',
  ADMIN_PIN: process.env.ADMIN_PIN || '0000',
  BUSINESS_PHONE: process.env.BUSINESS_PHONE || '02-XXX-XXXX',
  PUBLIC_URL: process.env.PUBLIC_URL || 'http://localhost:3001',
  BUSINESS_HOURS: '19:00 - 02:00',
  ALIGO_KEY: process.env.ALIGO_KEY || '',
  ALIGO_USER_ID: process.env.ALIGO_USER_ID || '',
  ALIGO_SENDER: process.env.ALIGO_SENDER || '',
  TWILIO_SID: process.env.TWILIO_SID || '',
  TWILIO_AUTH: process.env.TWILIO_AUTH || '',
  TWILIO_FROM: process.env.TWILIO_FROM || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  RESEND_FROM: process.env.RESEND_FROM || 'Pine & Co <noreply@pineandco.shop>',
  GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL || '',
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY || '',
  GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID || '',
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || '',
  SEATS: {
    bar: ['B1','B2','B3','B4','B5','B6','B7','B8','B9','B10','B11','B12','B13','B14'],
    tables: ['T1','T2','T3','T4'],
    highTables: ['H1','H2'],
    room: ['ROOM'],
  },
  CAPACITY: { T1:5,T2:5,T3:5,T4:5,H1:2,H2:2,ROOM:10,B1:1,B2:1,B3:1,B4:1,B5:1,B6:1,B7:1,B8:1,B9:1,B10:1,B11:1,B12:1,B13:1,B14:1 },
  ROOM_MIN_CHARGE: 300000,
  BAR_EDGE_SEATS: ['B1','B3','B4','B6'],
  BAR_MID_SEATS: ['B2','B5'],
  BAR_U_SEATS: ['B7','B8','B9','B10','B11','B12','B13','B14'],
  WEEKDAY_SLOTS: ['19:00','20:00','21:00','23:00'],
  WEEKEND_SLOTS: ['19:00','20:00','21:00'],
  LATE_SLOT: '23:00',
  LATE_BAR_MAX: 4,
  LATE_TABLE_MAX: 2,
};
// ── Data stored on persistent disk (survives deploys) ──
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE = path.join(DATA_DIR, 'reservations.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const STAFF_FILE = path.join(DATA_DIR, 'staff.json');
const VISITORS_FILE = path.join(DATA_DIR, 'visitors.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ── Auto-migrate: if persistent disk is empty, copy from old locations ──
function migrateData() {
  const oldPaths = [
    path.join(__dirname, 'data'),
    path.join(__dirname),
    '/opt/render/project/src/data',
    '/opt/render/project/src',
  ];
  const files = ['reservations.json', 'events.json', 'staff.json', 'visitors.json'];
  files.forEach(file => {
    const target = path.join(DATA_DIR, file);
    if (fs.existsSync(target) && fs.statSync(target).size > 10) return; // already has data
    for (const old of oldPaths) {
      const src = path.join(old, file);
      if (old === DATA_DIR) continue; // don't copy from self
      if (fs.existsSync(src) && fs.statSync(src).size > 10) {
        try {
          fs.copyFileSync(src, target);
          console.log('📦 Migrated: ' + src + ' → ' + target);
        } catch(e) { console.error('Migration error:', e.message); }
        break;
      }
    }
  });
}
if (process.env.DATA_DIR) migrateData(); // only migrate when persistent disk is configured

let reservations = [], events = {}, staffNames = ['DuUi','Manager'];
let visitors = [];
let lockPromise = Promise.resolve();
function withLock(fn) { lockPromise = lockPromise.then(fn).catch(e => { console.error(e); throw e; }); return lockPromise; }

function loadData() {
  try { if (fs.existsSync(DATA_FILE)) reservations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { reservations = []; }
  try { if (fs.existsSync(EVENTS_FILE)) events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch(e) { events = {}; }
  try { if (fs.existsSync(STAFF_FILE)) staffNames = JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8')); } catch(e) {}
  try { if (fs.existsSync(VISITORS_FILE)) visitors = JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf8')); } catch(e) { visitors = []; }
  console.log(`📂 Data dir: ${DATA_DIR}`);
  console.log(`📦 Loaded ${reservations.length} reservations, ${visitors.length} visitors, ${Object.keys(events).length} events`);
}

// Auto-backup every hour
function autoBackup() {
  try {
    const ts = new Date().toISOString().slice(0,13).replace(/[-:T]/g,'');
    fs.writeFileSync(path.join(BACKUP_DIR, 'res_'+ts+'.json'), JSON.stringify(reservations));
    // Keep only last 48 backups
    const files = fs.readdirSync(BACKUP_DIR).sort();
    while (files.length > 48) { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); }
    console.log('💾 Backup: ' + reservations.length + ' reservations');
  } catch(e) { console.error('Backup error:', e.message); }
}

function saveRes() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(reservations, null, 2)); } catch(e) { console.error(e); } }
function saveEvents() { try { fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2)); } catch(e) { console.error(e); } }
function saveStaff() { try { fs.writeFileSync(STAFF_FILE, JSON.stringify(staffNames, null, 2)); } catch(e) { console.error(e); } }
function saveVisitors() { try { fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2)); } catch(e) { console.error(e); } }

// Record a visit when guest is marked "seated"
function recordVisit(r) {
  if (!r.name || r.name === 'Guest') return;
  const clean = s => (s || '').replace(/[\s\-]/g, '').toLowerCase();
  // Find existing visitor by matching 2+ fields
  let found = visitors.find(v => {
    let matches = 0;
    if (v.name && r.name && v.name.toLowerCase() === r.name.toLowerCase()) matches++;
    if (v.phone && r.phone && clean(v.phone) === clean(r.phone)) matches++;
    if (v.email && r.email && v.email.toLowerCase() === r.email.toLowerCase()) matches++;
    if (v.instagram && r.instagram && v.instagram.toLowerCase() === r.instagram.toLowerCase()) matches++;
    return matches >= 2;
  });
  const visitCount = found ? found.visits.length + 1 : 1;
  if (found) {
    if (r.phone) found.phone = r.phone;
    if (r.email) found.email = r.email;
    if (r.instagram) found.instagram = r.instagram;
    found.visits.push({ date: r.date, partySize: r.partySize, zone: r.zone });
    found.lastVisit = r.date;
  } else {
    visitors.push({
      name: r.name, phone: r.phone || '', email: r.email || '', instagram: r.instagram || '',
      visits: [{ date: r.date, partySize: r.partySize, zone: r.zone }],
      lastVisit: r.date, firstVisit: r.date,
    });
  }
  saveVisitors();
  // Write to Google Sheets
  appendToSheet(r, visitCount);
}

// ── Google Sheets: append visit row ──
async function appendToSheet(r, visitCount) {
  if (!CONFIG.GOOGLE_SHEET_ID || !CONFIG.GOOGLE_CLIENT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY) return;
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT(
      CONFIG.GOOGLE_CLIENT_EMAIL, null,
      CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date(Date.now() + 9 * 3600000); // KST
    const row = [
      r.date,                                          // A: 날짜
      r.time || 'walkin',                              // B: 시간
      r.name,                                          // C: 이름
      r.partySize,                                     // D: 인원
      r.phone || '',                                   // E: 전화번호
      r.email || '',                                   // F: 이메일
      r.instagram || '',                               // G: 인스타
      r.zone || '',                                    // H: 좌석타입
      (r.seats || []).join(','),                        // I: 좌석번호
      r.source || '',                                  // J: 예약경로
      visitCount > 1 ? '재방문 (' + visitCount + '회)' : '신규',  // K: 방문유형
      r.notes || '',                                   // L: 특이사항
      now.toISOString().slice(0, 19).replace('T', ' '), // M: 기록시간
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:M',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    console.log('📊 [SHEETS] Added: ' + r.name + ' / ' + r.date);
  } catch (e) {
    console.error('📊 [SHEETS] Error:', e.message);
  }
}

// ── Log every reservation creation to "예약로그" sheet (backup) ──
async function logReservationCreation(r) {
  if (!CONFIG.GOOGLE_SHEET_ID || !CONFIG.GOOGLE_CLIENT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY) return;
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT(
      CONFIG.GOOGLE_CLIENT_EMAIL, null,
      CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date(Date.now() + 9 * 3600000);
    const row = [
      now.toISOString().slice(0, 19).replace('T', ' '),  // A: 접수시간
      r.confirmCode || '',                                // B: 확인코드
      r.date,                                             // C: 예약날짜
      r.time,                                             // D: 시간
      r.name,                                             // E: 이름
      r.partySize,                                        // F: 인원
      r.phone || '',                                      // G: 전화번호
      r.email || '',                                      // H: 이메일
      r.instagram || '',                                  // I: 인스타
      r.zone || '',                                       // J: 좌석타입
      (r.seats || []).join(','),                           // K: 좌석번호
      r.source || '',                                     // L: 예약경로
      r.notes || '',                                      // M: 특이사항
      r.status || 'confirmed',                            // N: 상태
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: '예약로그!A:N',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    console.log('📋 [LOG] Reservation logged: ' + r.name + ' / ' + r.date + ' / ' + (r.confirmCode || 'no-code'));
  } catch (e) {
    console.error('📋 [LOG] Error:', e.message);
  }
}

// Check if a guest is a returning visitor
function checkReturning(name, phone, email, instagram) {
  const clean = s => (s || '').replace(/[\s\-]/g, '').toLowerCase();
  for (const v of visitors) {
    let matches = 0;
    if (v.name && name && v.name.toLowerCase() === name.toLowerCase()) matches++;
    if (v.phone && phone && clean(v.phone) === clean(phone)) matches++;
    if (v.email && email && v.email.toLowerCase() === email.toLowerCase()) matches++;
    if (v.instagram && instagram && v.instagram.toLowerCase() === instagram.toLowerCase()) matches++;
    if (matches >= 2) {
      // Find most frequent zone (preferred seating)
      const zoneCounts = {};
      (v.visits || []).forEach(vis => { zoneCounts[vis.zone] = (zoneCounts[vis.zone]||0) + 1; });
      const prefZone = Object.keys(zoneCounts).sort((a,b) => zoneCounts[b] - zoneCounts[a])[0] || '';
      // Recent visits (last 5)
      const recentVisits = (v.visits || []).slice(-5).reverse().map(vis => vis.date + ' ' + (vis.zone||''));
      return {
        returning: true,
        visits: v.visits.length,
        lastVisit: v.lastVisit,
        firstVisit: v.firstVisit,
        prefZone: prefZone,
        recentVisits: recentVisits,
      };
    }
  }
  return { returning: false };
}
loadData();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function kstToday() { return new Date(Date.now() + 9*3600000).toISOString().slice(0,10); }
function isWeekend(d) { const day = new Date(d+'T12:00:00+09:00').getDay(); return day===5||day===6; }
function getSlots(d) { return isWeekend(d) ? CONFIG.WEEKEND_SLOTS : CONFIG.WEEKDAY_SLOTS; }
function getResFor(date,time) { return reservations.filter(r => r.date===date && r.time===time && r.status!=='cancelled' && r.status!=='noshow'); }
// Get ALL occupied seats for the entire date (only confirmed + seated count)
function getOccupiedForDate(date) {
  const s=[];
  reservations.filter(r => r.date===date && (r.status==='confirmed'||r.status==='seated'||r.status==='needs_assignment'))
    .forEach(r => { if(r.seats) s.push(...r.seats); });
  return s;
}

function autoAssign(date, time, partySize, preference) {
  // ═══ STRICT SEAT RULES — NEVER VIOLATE ═══
  // Bar B1-B14: 1명 per seat (2명 = 2개 별도 좌석)
  // High H1,H2: max 2명 each
  // Table T1-T4: 3~5명 only (2명 절대 안됨!)
  // Room: 6명+ only (30만원 개런티)
  
  const occ = getOccupiedForDate(date);
  const free = s => !occ.includes(s);
  const freeBar = CONFIG.SEATS.bar.filter(free);
  const freeHigh = CONFIG.SEATS.highTables.filter(free);
  const freeTables = CONFIG.SEATS.tables.filter(free);
  const freeRoom = free('ROOM');

  // ── 1명: 바 → 하이테이블 → 없으면 거절 ──
  if (partySize === 1) {
    for (const s of CONFIG.BAR_EDGE_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
    for (const s of CONFIG.BAR_U_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
    for (const s of CONFIG.BAR_MID_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
    if (freeHigh.length > 0) return { zone:'highTable', seats:[freeHigh[0]] };
    return null; // 바+하이 다 찼으면 거절
  }

  // ── 2명: 바(인접 2석) → 하이테이블 → 없으면 거절 (테이블 절대 안됨!) ──
  if (partySize === 2) {
    const barPairs = [['B7','B8'],['B9','B10'],['B11','B12'],['B13','B14'],['B1','B2'],['B4','B5']];
    for (const p of barPairs) if (p.every(free)) return { zone:'bar', seats:p };
    if (freeHigh.length > 0) return { zone:'highTable', seats:[freeHigh[0]] };
    // 바 쌍은 없지만 개별 바 2석이 있으면
    if (freeBar.length >= 2) return { zone:'bar', seats:[freeBar[0], freeBar[1]] };
    return null; // 바+하이 다 찼으면 거절 — 테이블에 2명 절대 안됨!
  }

  // ── 3~5명: 테이블만 → 없으면 거절 (룸 자동 안됨) ──
  if (partySize >= 3 && partySize <= 5) {
    for (const s of freeTables) return { zone:'table', seats:[s] };
    return null; // 테이블 다 찼으면 거절
  }

  // ── 6~10명: 룸만 → 없으면 거절 + 워크인/전화 안내 ──
  if (partySize >= 6 && partySize <= 10) {
    if (freeRoom) return { zone:'room', seats:['ROOM'], note: '30만원 minimum charge' };
    return null; // 룸 꽉 차면 거절
  }

  return null;
}

// ── Events (blocked dates) ──
app.get('/api/events', (req, res) => res.json(events));
app.post('/api/events/:date', (req, res) => {
  const { date } = req.params;
  const { pin, label } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  if (label) events[date] = label;
  else delete events[date];
  saveEvents();
  res.json({ ok: true, events });
});

// ── Availability ──
app.get('/api/availability/:date', (req, res) => {
  const { date } = req.params;
  if (events[date]) return res.json({ blocked: true, event: events[date] });
  const slots = getSlots(date);
  const occ = getOccupiedForDate(date); // whole-date occupancy

  const barFree = CONFIG.SEATS.bar.filter(s => !occ.includes(s)).length;
  const tablesFree = CONFIG.SEATS.tables.filter(s => !occ.includes(s)).length;
  const highFree = CONFIG.SEATS.highTables.filter(s => !occ.includes(s)).length;
  const roomFree = !occ.includes('ROOM') ? 1 : 0;

  const result = {};
  const kstNow = new Date(Date.now() + 9 * 3600000);
  const isToday = date === kstToday();
  const nowHour = kstNow.getHours() + kstNow.getMinutes() / 60;

  slots.forEach(time => {
    const isLate = time === CONFIG.LATE_SLOT && !isWeekend(date);
    let eBar = barFree, eTbl = tablesFree;
    if (isLate) {
      const ex = getResFor(date, time);
      const ub = ex.filter(r => r.zone==='bar').reduce((s,r) => s+r.partySize, 0);
      const ut = ex.filter(r => r.zone==='table'||r.zone==='highTable').length;
      eBar = Math.max(0, CONFIG.LATE_BAR_MAX - ub);
      eTbl = Math.max(0, CONFIG.LATE_TABLE_MAX - ut);
    }
    // All slots close at 17:00 (5PM) on the same day
    const slotHour = parseInt(time.split(':')[0]);
    const closed = isToday && nowHour >= 17;
    // Check which party sizes can actually book (using strict rules)
    const availPax = [];
    for (let ps = 1; ps <= 10; ps++) {
      if (autoAssign(date, time, ps, null)) availPax.push(ps);
    }
    result[time] = { bar:eBar, tables:eTbl, highTables:highFree, room:roomFree, isLate, closed, occupiedSeats:occ, availPax };
  });
  res.json(result);
});

// ── Detect preference from special request text ──
function detectPreference(text, partySize) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(bar|바|바좌석|바석)\b/.test(t)) return 'bar';
  if (/\b(room|룸|프라이빗|private)\b/.test(t)) return 'room_request';
  if (/\b(table|테이블|테이블석)\b/.test(t)) return 'table';
  return null;
}

// ── Guest reserve ──
app.post('/api/reserve', async (req, res) => {
  const { name, phone, instagram, email, partySize, date, time, specialRequest } = req.body;
  if (!name || !partySize || !date || !time) return res.status(400).json({ error: 'Required fields missing.' });
  if (partySize < 1 || partySize > 10) return res.status(400).json({ error: 'Party size 1-10.' });
  if (events[date]) return res.status(400).json({ error: 'This date is not available (event).' });
  const slots = getSlots(date);
  if (!slots.includes(time)) return res.status(400).json({ error: 'Invalid time.' });

  // All slots close at 17:00 on same day
  if (date === kstToday()) {
    const kstNow = new Date(Date.now() + 9 * 3600000);
    const nowHour = kstNow.getHours() + kstNow.getMinutes() / 60;
    if (nowHour >= 17) return res.status(400).json({ error: 'Today\'s reservations are closed. Walk-ins welcome after 7PM!' });
  }

  // ── Anti-abuse checks ──
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';

  // 1. Same phone/email can't book same date twice
  if (phone) {
    const cleanPhone = phone.replace(/[^0-9+]/g, '');
    const dup = reservations.find(r => r.date === date && r.phone && r.phone.replace(/[^0-9+]/g, '') === cleanPhone && r.status !== 'cancelled');
    if (dup) return res.status(400).json({ error: '이미 해당 날짜에 예약이 있습니다. 변경은 전화로 문의해주세요. / You already have a reservation on this date.' });
  }
  if (email) {
    const dup = reservations.find(r => r.date === date && r.email && r.email.toLowerCase() === email.toLowerCase() && r.status !== 'cancelled');
    if (dup) return res.status(400).json({ error: '이미 해당 날짜에 예약이 있습니다. / You already have a reservation on this date.' });
  }

  // 2. Max 3 active reservations per phone/email total
  if (phone) {
    const activeCount = reservations.filter(r => r.phone && r.phone.replace(/[^0-9+]/g, '') === phone.replace(/[^0-9+]/g, '') && r.status === 'confirmed').length;
    if (activeCount >= 3) return res.status(400).json({ error: '예약 가능 횟수를 초과했습니다. 기존 예약을 확인해주세요. / Maximum reservation limit reached.' });
  }

  // 3. Max 5 reservations per IP per day
  const today = kstToday();
  const ipCount = reservations.filter(r => r._ip === ip && r.createdAt && r.createdAt.startsWith(today)).length;
  if (ipCount >= 1) return res.status(429).json({ error: '오늘 이미 예약하셨습니다. 추가 예약은 전화로 문의해주세요. / You already made a reservation today. Please call for additional bookings.' });

  // No preference needed — autoAssign handles strict rules
  let preference = null;

  try {
    await withLock(async () => {
      const a = autoAssign(date, time, partySize, preference);
      if (!a) {
        if (partySize <= 2) throw new Error('Bar and high table seats are fully booked for this date. Please try another date or walk in.');
        if (partySize <= 5) throw new Error('Table seats are fully booked for this date. Please try another date or walk in.');
        if (partySize >= 6) throw new Error('The private room is fully booked. For groups of 6+, please call us at +82-10-6817-0406 or walk in.');
        throw new Error('No seats available.');
      }
      const confirmCode = 'PC' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2,4);
      const r = {
        id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
        confirmCode,
        name, phone: phone||'', instagram: instagram||'', email: email||'',
        partySize, date, time, preference: preference||'auto',
        zone: a.zone, seats: a.seats, status: 'confirmed', source: 'online',
        notes: specialRequest||'', createdAt: new Date().toISOString(),
        _ip: ip,
        reminderD1: false, reminderD0: false, modLog: [],
      };
      reservations.push(r); saveRes();
      sendConfirmation(r);
      logReservationCreation(r);
      console.log('🎫 Reservation confirmed: ' + name + ' / ' + date + ' ' + time + ' / Code: ' + confirmCode);
      res.json({ ok: true, reservation: r });
    });
  } catch(e) { res.status(409).json({ error: e.message }); }
});

// ── Staff routes ──
app.get('/api/staff-names', (req, res) => res.json(staffNames));
app.post('/api/staff-names', (req, res) => {
  const { pin, name } = req.body;
  if (pin !== CONFIG.ADMIN_PIN) return res.status(403).json({ error: 'Admin PIN required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const n = name.trim();
  if (staffNames.includes(n)) return res.status(400).json({ error: 'Already exists' });
  staffNames.push(n);
  saveStaff();
  res.json({ ok: true, staffNames });
});
app.delete('/api/staff-names/:name', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== CONFIG.ADMIN_PIN) return res.status(403).json({ error: 'Admin PIN required' });
  const n = decodeURIComponent(req.params.name);
  staffNames = staffNames.filter(s => s !== n);
  saveStaff();
  res.json({ ok: true, staffNames });
});
app.get('/api/month/:year/:month', (req, res) => {
  const prefix = `${req.params.year}-${String(req.params.month).padStart(2,'0')}`;
  const counts = {};
  const fullDates = [];
  reservations.forEach(r => { if (r.date.startsWith(prefix) && r.status!=='cancelled' && r.status!=='noshow' && r.status!=='seated') counts[r.date]=(counts[r.date]||0)+1; });
  // Check which dates are fully booked using STRICT rules
  // A date is FULLY BOOKED if autoAssign returns null for ALL party sizes
  const datesWithRes = new Set(Object.keys(counts));
  // Also check dates in the month even without reservations (for completeness)
  reservations.forEach(r => { if (r.date.startsWith(prefix)) datesWithRes.add(r.date); });
  datesWithRes.forEach(date => {
    const canBook = [1,2,3,4,5,6].some(pax => autoAssign(date, '19:00', pax, null) !== null);
    if (!canBook) fullDates.push(date);
  });
  res.json({ counts, fullDates });
});
app.post('/api/staff/reserve', (req, res) => {
  const { pin,name,phone,instagram,email,partySize,date,time,zone,seats,source,notes,staffName } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  const r = {
    id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
    name, phone:phone||'', instagram:instagram||'', email:email||'',
    partySize:partySize||1, date, time, preference:'',
    zone:zone||'bar', seats:seats||[], status:'confirmed',
    source:source||'staff', notes:notes||'',
    confirmCode: 'PC' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2,4),
    createdAt: new Date().toISOString(), reminderD1:false, reminderD0:false,
    modLog: [{ action:'created', by:staffName||'Staff', at:new Date().toISOString() }],
  };
  reservations.push(r); saveRes();
  logReservationCreation(r);
  res.json({ ok:true, reservation:r });
});
app.get('/api/reservations/:date', (req, res) => {
  const list = reservations.filter(r => r.date===req.params.date && r.status!=='cancelled');
  // Enrich with returning visitor info
  const enriched = list.map(r => {
    const rv = checkReturning(r.name, r.phone, r.email, r.instagram);
    return { ...r, _returning: rv.returning, _visitCount: rv.visits || 0, _lastVisit: rv.lastVisit || '', _firstVisit: rv.firstVisit || '', _prefZone: rv.prefZone || '', _recentVisits: rv.recentVisits || [] };
  });
  res.json(enriched);
});

// Check if a specific guest is returning
app.post('/api/check-returning', (req, res) => {
  const { name, phone, email, instagram } = req.body;
  const rv = checkReturning(name, phone, email, instagram);
  res.json(rv);
});

// Get all visitors (for export/spreadsheet)
app.get('/api/visitors', (req, res) => {
  res.json(visitors);
});

// List backups
app.get('/api/backups', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR).sort().reverse();
    const list = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
      return { file: f, count: data.length, size: fs.statSync(path.join(BACKUP_DIR, f)).size };
    });
    res.json({ ok: true, backups: list, dataDir: DATA_DIR });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Restore from backup
app.post('/api/restore-backup', (req, res) => {
  const { pin, file } = req.body;
  if (pin !== CONFIG.ADMIN_PIN) return res.status(403).json({ error: 'Admin PIN required' });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, file), 'utf8'));
    // Save current as emergency backup first
    fs.writeFileSync(path.join(BACKUP_DIR, 'emergency_before_restore.json'), JSON.stringify(reservations));
    reservations = data;
    saveRes();
    console.log('🔄 Restored from backup: ' + file + ' (' + data.length + ' reservations)');
    res.json({ ok: true, count: data.length });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Data health check
app.get('/api/data-health', (req, res) => {
  res.json({
    dataDir: DATA_DIR,
    reservationsFile: fs.existsSync(DATA_FILE),
    reservationCount: reservations.length,
    activeCount: reservations.filter(r => r.status==='confirmed'||r.status==='seated').length,
    backupCount: fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).length : 0,
    lastSave: fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtime : null,
  });
});

// Setup Google Sheet headers
app.post('/api/sheet-setup', async (req, res) => {
  if (req.body.pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  if (!CONFIG.GOOGLE_SHEET_ID || !CONFIG.GOOGLE_CLIENT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY) {
    return res.json({ ok: false, error: 'GOOGLE_SHEET_ID not configured' });
  }
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT(CONFIG.GOOGLE_CLIENT_EMAIL, null, CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), ['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth });
    // Sheet1 headers (방문기록)
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: 'Sheet1!A1:M1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['날짜','시간','이름','인원','전화번호','이메일','인스타','좌석타입','좌석번호','예약경로','방문유형','특이사항','기록시간']] },
    });
    // Create 예약로그 sheet tab (if not exists)
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: '예약로그' } } }] },
      });
    } catch(e) { /* sheet already exists, ignore */ }
    // 예약로그 headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: '예약로그!A1:N1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['접수시간','확인코드','예약날짜','시간','이름','인원','전화번호','이메일','인스타','좌석타입','좌석번호','예약경로','특이사항','상태']] },
    });
    res.json({ ok: true, message: 'Sheet1 + 예약로그 headers set!' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// Get all reservations created today (new bookings) - only unchecked
app.get('/api/new-today', (req, res) => {
  const today = kstToday();
  const newOnes = reservations.filter(r => r.createdAt && r.createdAt.startsWith(today) && r.status!=='cancelled' && !r.staffChecked);
  const enriched = newOnes.map(r => {
    const rv = checkReturning(r.name, r.phone, r.email, r.instagram);
    return { ...r, _returning: rv.returning, _visitCount: rv.visits || 0, _lastVisit: rv.lastVisit || '', _firstVisit: rv.firstVisit || '', _prefZone: rv.prefZone || '', _recentVisits: rv.recentVisits || [] };
  });
  res.json(enriched);
});
app.patch('/api/reservations/:id', (req, res) => {
  const r = reservations.find(x => x.id===req.params.id);
  if (!r) return res.status(404).json({ error:'Not found' });
  const ch = [];
  if (req.body.status && req.body.status!==r.status) { ch.push('status:'+r.status+'→'+req.body.status); r.status=req.body.status; if(r.status==='seated') recordVisit(r); }
  if (req.body.notes!==undefined && req.body.notes!==r.notes) { ch.push('notes updated'); r.notes=req.body.notes; }
  if (req.body.source && req.body.source!==r.source) { ch.push('source:'+r.source+'→'+req.body.source); r.source=req.body.source; }
  if (req.body.seats) {
    const old = r.seats ? r.seats.join(',') : 'none';
    r.seats = req.body.seats;
    if (req.body.zone) r.zone = req.body.zone;
    ch.push('seat:'+old+'→'+req.body.seats.join(','));
    if (r.status === 'needs_assignment') r.status = 'confirmed';
  }
  if (req.body.notified !== undefined) { r.notified = req.body.notified; ch.push('notified: ' + req.body.notified); }
  if (req.body.notifiedSeats !== undefined) { r.notifiedSeats = req.body.notifiedSeats; ch.push('notified seats: ' + req.body.notifiedSeats.join(',')); }
  if (req.body.untilTime !== undefined) { r.untilTime = req.body.untilTime; ch.push('until: ' + (req.body.untilTime || 'cleared')); }
  if (req.body.staffChecked !== undefined) { r.staffChecked = req.body.staffChecked; }
  if (ch.length) { if(!r.modLog)r.modLog=[]; r.modLog.push({ action:ch.join(', '), by:req.body.staffName||'Staff', at:new Date().toISOString() }); }
  saveRes(); res.json({ ok:true, reservation:r });
});

// Swap seats between two reservations
app.post('/api/swap-seats', (req, res) => {
  const { id1, id2, staffName } = req.body;
  const r1 = reservations.find(x => x.id===id1);
  const r2 = reservations.find(x => x.id===id2);
  if (!r1 || !r2) return res.status(404).json({ error:'Reservation not found' });
  const s1 = r1.seats, z1 = r1.zone;
  r1.seats = r2.seats; r1.zone = r2.zone;
  r2.seats = s1; r2.zone = z1;
  const ts = new Date().toISOString();
  if(!r1.modLog)r1.modLog=[];if(!r2.modLog)r2.modLog=[];
  r1.modLog.push({ action:'swapped with '+r2.name+': '+s1.join(',')+'→'+r1.seats.join(','), by:staffName||'Staff', at:ts });
  r2.modLog.push({ action:'swapped with '+r1.name+': '+r2.seats.join(',')+'→'+s1.join(','), by:staffName||'Staff', at:ts });
  saveRes();
  res.json({ ok:true });
});

// Walk-in: temporary seat assignment (sit until a reserved time)
app.post('/api/walkin', (req, res) => {
  const { pin, name, partySize, seats, zone, untilTime, date, staffName } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error:'Wrong PIN' });
  const r = {
    id: 'wi_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    name: name || 'Walk-in', phone:'', instagram:'', email:'',
    partySize: partySize || 1, date: date || kstToday(),
    time: 'walkin', preference: 'manual',
    zone: zone || 'bar', seats: seats || [],
    status: 'seated', source: 'walkin',
    untilTime: untilTime || '',
    notified: false,
    notes: untilTime ? '⏰ ' + untilTime + '까지 이용' : 'Walk-in',
    createdAt: new Date().toISOString(),
    reminderD1:false, reminderD0:false,
    modLog:[{ action:'walk-in seated', by:staffName||'Staff', at:new Date().toISOString() }],
  };
  reservations.push(r); saveRes();
  res.json({ ok:true, reservation:r });
});
app.delete('/api/reservations/:id', (req, res) => {
  reservations = reservations.filter(r => r.id!==req.params.id); saveRes(); res.json({ ok:true });
});

// Diagnostic: check what's happening for a specific date
app.get('/api/debug/:date', (req, res) => {
  const date = req.params.date;
  const occ = getOccupiedForDate(date);
  const allRes = reservations.filter(r => r.date === date);
  const activeRes = allRes.filter(r => r.status !== 'cancelled' && r.status !== 'noshow');
  const slots = getSlots(date);
  const isWknd = isWeekend(date);
  const freeBar = CONFIG.SEATS.bar.filter(s => !occ.includes(s));
  const freeTables = CONFIG.SEATS.tables.filter(s => !occ.includes(s));
  const freeHigh = CONFIG.SEATS.highTables.filter(s => !occ.includes(s));
  const freeRoom = !occ.includes('ROOM');

  // Test autoAssign for each party size
  const tests = {};
  [1,2,3,4,5,6].forEach(ps => {
    tests[ps+'pax'] = autoAssign(date, '19:00', ps, null);
  });

  res.json({
    date, isWeekend: isWknd, slots,
    totalReservations: allRes.length,
    activeReservations: activeRes.length,
    occupiedSeats: occ,
    freeBar: freeBar.length, freeTables: freeTables.length, freeHigh: freeHigh.length, freeRoom,
    events: events[date] || null,
    autoAssignTests: tests,
    reservationDetails: activeRes.map(r => ({ id:r.id, name:r.name, time:r.time, partySize:r.partySize, seats:r.seats, status:r.status, source:r.source })),
  });
});
// Get history (seated + noshow + completed) for viewing
app.get('/api/history', (req, res) => {
  const hist = reservations.filter(r => r.status==='seated'||r.status==='noshow'||r.status==='completed')
    .sort((a,b) => b.date < a.date ? -1 : 1);
  res.json(hist);
});

// Verify reservation by confirmation code
app.get('/api/verify/:code', (req, res) => {
  const r = reservations.find(x => x.confirmCode === req.params.code);
  if (r) res.json({ ok: true, reservation: { name: r.name, date: r.date, time: r.time, partySize: r.partySize, status: r.status } });
  else res.json({ ok: false, error: 'Reservation not found' });
});

app.get('/api/stats/noshow', (req, res) => {
  const t=reservations.length, n=reservations.filter(r=>r.status==='noshow').length;
  res.json({ total:t, noshows:n, rate:(t?Math.round(n/t*100):0)+'%' });
});

// ── SMS routing: Korean numbers → Aligo, International → Twilio ──
function isKoreanNumber(phone) {
  const cleaned = phone.replace(/[^0-9+]/g, '');
  return cleaned.startsWith('010') || cleaned.startsWith('011') || cleaned.startsWith('+82') || cleaned.startsWith('82');
}

function sendSMS(to, msg) {
  const cleaned = to.replace(/[^0-9+]/g, '');
  if (!cleaned) return;

  if (isKoreanNumber(cleaned)) {
    sendAligoSMS(cleaned, msg);
  } else {
    sendTwilioSMS(cleaned, msg);
  }
}

function sendAligoSMS(to, msg) {
  if (!CONFIG.ALIGO_KEY) { console.log('📱 [ALIGO SIM] '+to+'\n'+msg+'\n'); return; }
  const p = new URLSearchParams({ key:CONFIG.ALIGO_KEY, user_id:CONFIG.ALIGO_USER_ID, sender:CONFIG.ALIGO_SENDER, receiver:to.replace(/[^0-9]/g,''), msg, msg_type:'LMS' });
  fetch('https://apis.aligo.in/send/',{method:'POST',body:p}).then(r=>r.json()).then(d=>console.log('Aligo:',d)).catch(e=>console.error('Aligo error:',e));
}

function sendTwilioSMS(to, msg) {
  if (!CONFIG.TWILIO_SID || !CONFIG.TWILIO_AUTH) { console.log('📱 [TWILIO SIM] '+to+'\n'+msg+'\n'); return; }
  let dest = to;
  if (!dest.startsWith('+')) dest = '+' + dest;
  const auth = Buffer.from(CONFIG.TWILIO_SID + ':' + CONFIG.TWILIO_AUTH).toString('base64');
  const body = new URLSearchParams({ From: CONFIG.TWILIO_FROM, To: dest, Body: msg });
  fetch('https://api.twilio.com/2010-04-01/Accounts/' + CONFIG.TWILIO_SID + '/Messages.json', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body,
  }).then(r => r.json()).then(d => console.log('Twilio:', d.sid || d.message)).catch(e => console.error('Twilio error:', e));
}

// ── Email (Resend API) ──
function sendConfirmEmail(toEmail, reservation) {
  if (!CONFIG.RESEND_API_KEY) {
    console.log('📧 [EMAIL SIM] To: '+toEmail);
    console.log('  Reservation: '+reservation.name+' / '+reservation.date+' '+reservation.time+' / '+reservation.partySize+'명\n');
    return;
  }
  const r = reservation;
  const zoneKR = {bar:'바 좌석',table:'테이블',highTable:'하이테이블',room:'프라이빗 룸'};
  const zoneName = zoneKR[r.zone] || r.zone;
  let roomNote = '';
  if (r.zone === 'room') roomNote = '<p style="color:#c9a96e;font-size:13px;">미니멈차지 ₩300,000 / Minimum charge ₩300,000</p>';

  const html = `
<div style="max-width:480px;margin:0 auto;font-family:'Helvetica Neue',sans-serif;background:#1e1208;color:#f0ebe0;padding:40px 30px;border-radius:12px;">
  <div style="text-align:center;margin-bottom:24px;">
    <h1 style="font-family:Georgia,serif;font-size:24px;color:#b8935a;font-weight:400;letter-spacing:4px;margin:0;">PINE &amp; CO</h1>
    <p style="font-family:Georgia,serif;font-size:10px;color:#c9a96e;letter-spacing:6px;margin:4px 0 0;">SEOUL</p>
  </div>
  <div style="width:40px;height:1px;background:#b8935a;margin:0 auto 24px;opacity:.5;"></div>
  <h2 style="font-family:Georgia,serif;font-size:16px;color:#b8935a;text-align:center;font-weight:400;letter-spacing:2px;margin-bottom:20px;">RESERVATION CONFIRMED</h2>
  <div style="background:rgba(184,147,90,.08);border:1px solid rgba(184,147,90,.2);border-radius:8px;padding:20px;margin-bottom:20px;">
    <table style="width:100%;font-size:14px;color:#f0ebe0;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#c9a96e;width:80px;">Date</td><td style="padding:6px 0;font-weight:500;">${r.date}</td></tr>
      <tr><td style="padding:6px 0;color:#c9a96e;">Time</td><td style="padding:6px 0;font-weight:500;">${r.time}</td></tr>
      <tr><td style="padding:6px 0;color:#c9a96e;">Name</td><td style="padding:6px 0;">${r.name}</td></tr>
      <tr><td style="padding:6px 0;color:#c9a96e;">Party</td><td style="padding:6px 0;">${r.partySize}명</td></tr>
      <tr><td style="padding:6px 0;color:#c9a96e;">Seat</td><td style="padding:6px 0;">${zoneName}</td></tr>
    </table>
    ${roomNote}
  </div>
  <div style="text-align:center;font-size:12px;color:#c9a96e;line-height:1.8;">
    <p>예약 취소는 전화로만 가능합니다.</p>
    <p>To cancel, please call:</p>
    <p style="font-size:14px;color:#b8935a;font-weight:500;">${CONFIG.BUSINESS_PHONE}</p>
  </div>
  <div style="width:40px;height:1px;background:#b8935a;margin:24px auto;opacity:.3;"></div>
  <p style="text-align:center;font-size:10px;color:#c9a96e;opacity:.5;">Open 7PM — 2AM</p>
</div>`;

  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + CONFIG.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: CONFIG.RESEND_FROM,
      to: [toEmail],
      subject: `[PINE&CO] Reservation Confirmed — ${r.date} ${r.time}`,
      html: html,
    }),
  }).then(resp => resp.json()).then(d => console.log('Email sent:', d)).catch(e => console.error('Email error:', e));
}

// ── Send all confirmations ──
function sendConfirmation(reservation) {
  const r = reservation;
  const msg = `[PINE&CO] ${r.name}님, 예약이 확인되었습니다.\n날짜: ${r.date} ${r.time}\n인원: ${r.partySize}명\n취소는 전화로만: ${CONFIG.BUSINESS_PHONE}\n\n[PINE&CO] Confirmed.\n${r.date} ${r.time} / Party: ${r.partySize}\nTo cancel: ${CONFIG.BUSINESS_PHONE}`;
  if (r.phone) sendSMS(r.phone, msg);
  if (r.email) sendConfirmEmail(r.email, r);
}

// ── Reminders ──
function sendReminders() {
  const today=kstToday(), tmrw=new Date(Date.now()+9*3600000+86400000).toISOString().slice(0,10);
  reservations.forEach(r => {
    if(r.status!=='confirmed') return;
    if(r.date===tmrw&&!r.reminderD1){
      const msg=`[PINE&CO] ${r.name}님, 내일 예약 확인: ${r.date} ${r.time} / ${r.partySize}명\n변경/취소: ${CONFIG.BUSINESS_PHONE}`;
      if(r.phone) sendSMS(r.phone, msg);
      if(r.email) sendConfirmEmail(r.email, {...r, _reminderType:'D-1'});
      r.reminderD1=true; saveRes();
    }
    if(r.date===today&&!r.reminderD0){
      const msg=`[PINE&CO] ${r.name}님, 오늘 예약 확인: ${r.time} / ${r.partySize}명\n오늘 뵙겠습니다!`;
      if(r.phone) sendSMS(r.phone, msg);
      if(r.email) sendConfirmEmail(r.email, {...r, _reminderType:'D-0'});
      r.reminderD0=true; saveRes();
    }
  });
}

// ── Google Calendar Sync ──
// ── Parse free-form Google Calendar entry ──
function parseGcalEntry(text) {
  const result = { name:'Guest', time:null, partySize:2, phone:'', instagram:'', staffName:'', raw:text };
  if (!text) return result;

  // First, try to find time anywhere in the full text (not just per-part)
  // Patterns: 7:30, 7:30pm, 8pm, 8PM, 8시, 오후8시, 9PM, 21:00
  const fullTimeMatch = text.match(/(\d{1,2})\s*:\s*(\d{2})\s*(pm|am|PM|AM)?/)
    || text.match(/(\d{1,2})\s*(pm|PM|am|AM)\b/)
    || text.match(/(\d{1,2})\s*시/)
    || text.match(/오후\s*(\d{1,2})\s*시?/);
  if (fullTimeMatch) {
    let h = parseInt(fullTimeMatch[1]);
    const ampm = (fullTimeMatch[3] || fullTimeMatch[2] || '').toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (text.includes('오후') && h < 12) h += 12;
    // For a bar open 7PM-2AM: any hour 1-12 without am/pm → assume PM
    if (!ampm && !text.includes('오후') && h >= 1 && h <= 12) h += 12;
    // If still morning (like 7 → 19, 8 → 20), force to PM
    if (h >= 1 && h <= 6) h += 12; // 1am-6am range (late night)
    if (h >= 7 && h <= 12) h += 12; // if somehow still AM range
    // Clamp to valid range
    if (h > 24) h = h - 12;
    result.time = String(h).padStart(2, '0') + ':00';
    result.exactTime = fullTimeMatch[0];
  }

  // Also extract phone from full text (for space-separated entries)
  if (!result.phone) {
    const phoneInText = text.match(/\b(01[0-9][\-\s]?\d{3,4}[\-\s]?\d{4})\b/) || text.match(/(\+\d{10,15})/) || text.match(/Contact\s*:\s*([\+\d\s\-]{10,})/i);
    if (phoneInText) result.phone = phoneInText[1].replace(/[\s\-]/g, '');
  }

  // Extract Name: pattern from full text
  const nameInText = text.match(/Name\s*:\s*([A-Za-z\u3131-\uD79D]+(?:\s+[A-Za-z\u3131-\uD79D]+)*)/i);
  if (nameInText) result.name = nameInText[1].trim();

  // Split by / , · or multiple spaces for other fields
  const parts = text.split(/[\/·,]|\s{2,}/).map(s => s.trim()).filter(Boolean);
  const unmatched = [];

  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;

    // Instagram: starts with @ or contains "Instagram" followed by handle
    if (/^@\w/.test(p)) { result.instagram = p; continue; }
    const igMatch = p.match(/(?:instagram|ig|insta)\s*[:\s]\s*@?(\w+)/i);
    if (igMatch) { result.instagram = '@' + igMatch[1]; continue; }

    // Skip time-like strings (already parsed from full text)
    if (/^\d{1,2}\s*:\s*\d{2}/.test(p)) continue;
    if (/^\d{1,2}\s*(pm|am|PM|AM)$/.test(p)) continue;
    if (/^\d{1,2}\s*시$/.test(p)) continue;
    if (/^오후/.test(p)) continue;

    // Party size: 2pax, 3명, 4people, 5p, "Number of People:2"
    const paxMatch = p.match(/(\d{1,2})\s*(pax|명|people|persons|guests|PAX)/i);
    if (paxMatch) { result.partySize = parseInt(paxMatch[1]); continue; }
    const nopMatch = p.match(/Number\s*of\s*People\s*:\s*(\d+)/i);
    if (nopMatch) { result.partySize = parseInt(nopMatch[1]); continue; }
    // Standalone small number
    if (/^\d{1,2}$/.test(p) && parseInt(p) >= 1 && parseInt(p) <= 10 && !result._gotPax) {
      result.partySize = parseInt(p); result._gotPax = true; continue;
    }
    // "2명" embedded in text
    const paxEmbed = p.match(/^(\d{1,2})명$/);
    if (paxEmbed) { result.partySize = parseInt(paxEmbed[1]); continue; }

    // Phone: 8+ digits
    const phoneClean = p.replace(/[\s\-().]/g, '');
    if (/^[\+]?\d{8,15}$/.test(phoneClean)) { result.phone = phoneClean; continue; }
    // "Contact: +86..." format
    const contactMatch = p.match(/Contact\s*:\s*([\+\d\s\-]+)/i);
    if (contactMatch) { result.phone = contactMatch[1].replace(/[\s\-]/g, ''); continue; }

    // Skip known keywords
    if (/^(Name|Date|Time|Contact|Number|Hi+!*|전화예약|신규|가게전화|바좌석|요정|요청)\s*:?$/i.test(p)) continue;
    // "Name:Zosia" format
    const nameMatch = p.match(/^Name\s*:\s*(.+)/i);
    if (nameMatch && result.name === 'Guest') { result.name = nameMatch[1].trim(); continue; }

    // Everything else is text
    unmatched.push(p);
  }

  // First unmatched = guest name (if not set by Name: pattern)
  if (unmatched.length >= 1 && result.name === 'Guest') result.name = unmatched[0];
  // Fallback: if still Guest, try first word that looks like a name from raw text
  if (result.name === 'Guest' || result.name === 'April 10th') {
    const words = text.split(/[\s\/,·]+/);
    for (const w of words) {
      if (!w) continue;
      if (/^\d/.test(w)) continue; // starts with number
      if (/^[@+]/.test(w)) continue; // instagram or phone
      if (/^(Name|Date|Time|Contact|Number|Hi+|Instagram|of|People|Friday|April|and|the|th|PM|AM|pax|Pax|PAX)\b/i.test(w)) continue;
      if (/^(신규|가게전화|전화예약|바좌석|요정|요청|오후|오전)\b/.test(w)) continue;
      if (w.length < 2) continue;
      result.name = w.replace(/님$/, ''); // remove 님 suffix
      break;
    }
  }
  // Last unmatched = staff (if 2+ unmatched and not a keyword)
  if (unmatched.length >= 2) {
    const last = unmatched[unmatched.length - 1];
    if (!/^(bar|table|room|바|테이블|룸|counter|private|신규|가게전화|전화예약)\s*$/i.test(last)) {
      result.staffName = last;
    }
  }

  delete result._gotPax;
  return result;
}

// ── Force time to nearest valid slot ──
function snapToSlot(time, date) {
  const slots = isWeekend(date) ? CONFIG.WEEKEND_SLOTS : CONFIG.WEEKDAY_SLOTS;
  if (slots.includes(time)) return time;
  // Find nearest slot
  const h = parseInt(time.split(':')[0]);
  let best = slots[0];
  let bestDiff = 999;
  slots.forEach(s => {
    const sh = parseInt(s.split(':')[0]);
    const diff = Math.abs(sh - h);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  });
  return best;
}


// Helper: get start of today in UTC (for fetching all of today's events)
function todayStartUTC() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  const start = new Date(kst.getFullYear(), kst.getMonth(), kst.getDate());
  return new Date(start.getTime() - 9 * 3600000);
}

async function syncGoogleCalendar() {
  if (!CONFIG.GOOGLE_CLIENT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY || !CONFIG.GOOGLE_CALENDAR_ID) {
    console.log('📅 [GCAL] No credentials, skipping sync');
    return { added:0, warnings:[], total:0 };
  }
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT(
      CONFIG.GOOGLE_CLIENT_EMAIL,
      null,
      CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/calendar.readonly']
    );
    const cal = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const twoMonths = new Date(now.getTime() + 62 * 86400000);
    const res = await cal.events.list({
      calendarId: CONFIG.GOOGLE_CALENDAR_ID,
      timeMin: todayStartUTC().toISOString(),
      timeMax: twoMonths.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 500,
    });
    const gcalEvents = res.data.items || [];
    let added = 0;
    const warnings = [];

    gcalEvents.forEach(ev => {
      if (reservations.find(r => r.gcalId === ev.id)) return; // already imported
      if (ev.status === 'cancelled') return;

      const title = ev.summary || '';
      const desc = ev.description || '';
      if (!title.trim() && !desc.trim()) return;

      const fullText = title + (desc ? ' / ' + desc : '');

      // Check if this looks like a reservation
      if (!looksLikeReservation(fullText)) {
        console.log('📅 [GCAL] Skipped (not a reservation): ' + title);
        return;
      }

      let date, fallbackTime;
      if (ev.start && ev.start.dateTime) {
        const start = new Date(ev.start.dateTime);
        date = start.toISOString().slice(0, 10);
        fallbackTime = String(start.getHours()).padStart(2, '0') + ':00';
      } else if (ev.start && ev.start.date) {
        date = ev.start.date;
        fallbackTime = '19:00';
      } else {
        // NO date? Still import with today's date
        date = kstToday();
        fallbackTime = '19:00';
        warnings.push('⚠️ 날짜없음: ' + title + ' → 오늘로 배정');
      }

      const parsed = parseGcalEntry(fullText);
      // Use parsed time, fallback to calendar time, then snap to nearest valid slot
      let rawTime = parsed.time || fallbackTime;
      const time = snapToSlot(rawTime, date);
      const pref = detectPreference(fullText, parsed.partySize);
      const a = autoAssign(date, time, parsed.partySize, pref);

      let notes = '📅 ' + title;
      if (parsed.exactTime) notes += '\n⏰ 정확한 시간: ' + parsed.exactTime;
      if (parsed.staffName) notes += '\n👤 담당: ' + parsed.staffName;
      if (desc) notes += '\n📄 ' + desc;

      let status = 'confirmed';
      if (!a) {
        status = 'needs_assignment';
        warnings.push('🚨 좌석부족: ' + parsed.name + ' / ' + date + ' ' + time + ' / ' + parsed.partySize + '명');
        notes += '\n\n🚨 자동 좌석 배정 실패 — 수동 배정 필요!';
      }

      if (parsed.name === 'Guest' && title.trim()) {
        parsed.name = title.split(/[\/·,]/)[0].trim() || 'Guest';
      }

      reservations.push({
        id: 'gc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        gcalId: ev.id,
        name: parsed.name, phone: parsed.phone, instagram: parsed.instagram, email: '',
        partySize: parsed.partySize, date, time, preference: pref || 'auto',
        zone: a ? a.zone : 'unassigned', seats: a ? a.seats : [],
        status, source: 'google_calendar', notes,
        confirmCode: 'PC' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2,4),
        createdAt: new Date().toISOString(), reminderD1: false, reminderD0: false,
        modLog: [{ action: 'Google Calendar import' + (a ? '' : ' (⚠️미배정)'), by: parsed.staffName || 'System', at: new Date().toISOString() }],
      });
      logReservationCreation(reservations[reservations.length - 1]);
      added++;
      console.log('📅 ' + (a ? '✅' : '⚠️') + ' ' + parsed.name + ' / ' + date + ' ' + time + ' / ' + parsed.partySize + 'pax' + (parsed.phone ? ' / ' + parsed.phone : '') + (parsed.instagram ? ' / ' + parsed.instagram : ''));
    });

    if (added > 0) saveRes();
    console.log('📅 [GCAL] +' + added + ' / warnings:' + warnings.length + ' / total events:' + gcalEvents.length);
    return { added, warnings, total: gcalEvents.length };
  } catch (e) {
    console.error('📅 [GCAL] Error:', e.message);
    return { added: 0, warnings: ['❌ ' + e.message], total: 0 };
  }
}

// ── Sync report: show ALL gcal events and their status ──
// Helper: check if text looks like a reservation
function looksLikeReservation(text) {
  if (!text) return false;
  const hasTime = /\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*(pm|am|PM|AM)|\d{1,2}\s*시|오후/.test(text);
  const hasPax = /\d+\s*(pax|명|people|persons|guests|PAX)|Number\s*of\s*People/i.test(text);
  const hasPhone = /01[0-9][\-\s]?\d{3,4}[\-\s]?\d{4}|\+\d{10,}|Contact\s*:/i.test(text);
  const hasInsta = /@\w|instagram|ig\s*:/i.test(text);
  const hasName = /^Name\s*:/im.test(text);
  return hasTime || hasPax || hasPhone || hasInsta || hasName;
}

app.post('/api/gcal-report', async (req, res) => {
  const { pin } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  if (!CONFIG.GOOGLE_CLIENT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY || !CONFIG.GOOGLE_CALENDAR_ID) {
    return res.json({ ok: false, error: 'Google Calendar not configured' });
  }
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT(CONFIG.GOOGLE_CLIENT_EMAIL, null, CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), ['https://www.googleapis.com/auth/calendar.readonly']);
    const cal = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const twoMonths = new Date(now.getTime() + 62 * 86400000);
    const r = await cal.events.list({ calendarId: CONFIG.GOOGLE_CALENDAR_ID, timeMin: todayStartUTC().toISOString(), timeMax: twoMonths.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 500 });
    const events = (r.data.items || []).filter(ev => ev.status !== 'cancelled' && (ev.summary || '').trim() && looksLikeReservation((ev.summary||'') + ' ' + (ev.description||'')));
    const report = events.map(ev => {
      const imported = reservations.find(x => x.gcalId === ev.id);
      const title = ev.summary || '';
      let date = '';
      if (ev.start && ev.start.dateTime) date = new Date(ev.start.dateTime).toISOString().slice(0, 10);
      else if (ev.start && ev.start.date) date = ev.start.date;
      const parsed = parseGcalEntry(title + (ev.description ? ' / ' + ev.description : ''));
      return { gcalId: ev.id, title, date, parsed: { name: parsed.name, time: parsed.time, partySize: parsed.partySize, phone: parsed.phone, instagram: parsed.instagram, staffName: parsed.staffName }, imported: !!imported, systemId: imported ? imported.id : null, systemStatus: imported ? imported.status : null };
    });
    res.json({ ok: true, total: events.length, imported: report.filter(r => r.imported).length, missing: report.filter(r => !r.imported).length, report });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Bulk import: paste multiple reservations at once ──
app.post('/api/bulk-import', async (req, res) => {
  const { pin, text, date } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  if (!text || !date) return res.status(400).json({ error: 'Text and date required' });

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    const parsed = parseGcalEntry(line);
    const time = parsed.time || '19:00';
    const pref = detectPreference(line, parsed.partySize);
    const a = autoAssign(date, time, parsed.partySize, pref);

    // Always create, even without seat
    const r = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: parsed.name, phone: parsed.phone, instagram: parsed.instagram, email: '',
      partySize: parsed.partySize, date, time, preference: pref || 'auto',
      zone: a ? a.zone : 'unassigned', seats: a ? a.seats : [],
      status: a ? 'confirmed' : 'needs_assignment',
      source: 'bulk_import', notes: '원본: ' + line + (parsed.staffName ? '\n👤 담당: ' + parsed.staffName : ''),
      createdAt: new Date().toISOString(), reminderD1: false, reminderD0: false,
      modLog: [{ action: 'bulk import', by: req.body.staffName || 'Staff', at: new Date().toISOString() }],
    };
    reservations.push(r);
    results.push({ line, name: parsed.name, time, partySize: parsed.partySize, phone: parsed.phone, instagram: parsed.instagram, assigned: !!a, zone: r.zone });
  }
  saveRes();
  res.json({ ok: true, count: results.length, results });
});

// Staff: trigger manual sync
app.post('/api/gcal-sync', async (req, res) => {
  const { pin } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  // Clear previously imported gcal reservations to re-import all
  if (req.body.force) {
    const before = reservations.length;
    reservations = reservations.filter(r => r.source !== 'google_calendar');
    saveRes();
    console.log('📅 [GCAL] Force: cleared ' + (before - reservations.length) + ' old gcal imports');
  }
  const result = await syncGoogleCalendar();
  res.json({ ok: true, added: result.added, warnings: result.warnings, total: result.total, reservationCount: reservations.length });
});

// Diagnostic: test Google Calendar connection
app.post('/api/gcal-test', async (req, res) => {
  const { pin } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });

  const diag = {
    hasEmail: !!CONFIG.GOOGLE_CLIENT_EMAIL,
    hasKey: !!CONFIG.GOOGLE_PRIVATE_KEY,
    keyLength: (CONFIG.GOOGLE_PRIVATE_KEY || '').length,
    hasCalId: !!CONFIG.GOOGLE_CALENDAR_ID,
    calId: CONFIG.GOOGLE_CALENDAR_ID || '(empty)',
    email: CONFIG.GOOGLE_CLIENT_EMAIL || '(empty)',
  };

  if (!diag.hasEmail || !diag.hasKey || !diag.hasCalId) {
    return res.json({ ok: false, error: 'Missing env vars', diag });
  }

  try {
    const { google } = require('googleapis');
    const key = CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    diag.keyStart = key.substring(0, 30);
    diag.keyHasNewlines = key.includes('\n');

    const auth = new google.auth.JWT(CONFIG.GOOGLE_CLIENT_EMAIL, null, key, ['https://www.googleapis.com/auth/calendar.readonly']);
    const cal = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const twoMonths = new Date(now.getTime() + 62 * 86400000);
    const result = await cal.events.list({
      calendarId: CONFIG.GOOGLE_CALENDAR_ID,
      timeMin: todayStartUTC().toISOString(),
      timeMax: twoMonths.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 500,
    });

    const events = result.data.items || [];
    const alreadyImported = [];
    const notImported = [];

    events.forEach(ev => {
      if (ev.status === 'cancelled') return;
      const title = ev.summary || '(no title)';
      const fullText = title + ' ' + (ev.description || '');
      if (!looksLikeReservation(fullText)) return; // skip non-reservations
      let date = '';
      if (ev.start && ev.start.dateTime) date = new Date(ev.start.dateTime).toISOString().slice(0, 10);
      else if (ev.start && ev.start.date) date = ev.start.date;
      const existing = reservations.find(r => r.gcalId === ev.id);
      const entry = { id: ev.id, title, date, imported: !!existing };
      if (existing) alreadyImported.push(entry);
      else notImported.push(entry);
    });

    res.json({
      ok: true,
      totalEvents: events.length,
      alreadyImported: alreadyImported.length,
      notImported: notImported.length,
      notImportedList: notImported,
      alreadyImportedList: alreadyImported,
      diag,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, diag });
  }
});

function cleanup() {
  const cut=Date.now()-7*86400000, b=reservations.length;
  reservations=reservations.filter(r=>new Date(r.date+'T23:59:59+09:00').getTime()>cut);
  if(reservations.length!==b){ console.log('Cleaned '+(b-reservations.length)); saveRes(); }
}

app.listen(CONFIG.PORT, () => {
  cleanup(); sendReminders(); syncGoogleCalendar(); autoBackup();
  setInterval(sendReminders, 30*60000);
  setInterval(syncGoogleCalendar, 60*60000); // sync every hour
  setInterval(autoBackup, 60*60000); // backup every hour
  console.log('\n🌲 PINE&CO Reserve | http://localhost:'+CONFIG.PORT+'\n');
});
