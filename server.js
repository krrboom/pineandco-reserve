// ╔══════════════════════════════════════════════════════════════╗
// ║  Pine & Co Seoul — Unified System (Reserve + Waiting)        ║
// ║  Single server serving:                                      ║
// ║    /reserve.html  → reservation booking (guest)              ║
// ║    /customer.html → waiting list (guest)                     ║
// ║    /manage.html   → unified staff dashboard                  ║
// ║    /game.html     → cocktail lab game                        ║
// ╚══════════════════════════════════════════════════════════════╝

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const qs         = require('querystring');
const nodemailer = require('nodemailer');

// ─────────────────────────────────────────────────────────────
//  CONFIG — merged from both systems
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  // Ports & access
  PORT           : process.env.PORT || 3000,
  STAFF_PIN      : process.env.STAFF_PIN || '1234',
  ADMIN_PIN      : process.env.ADMIN_PIN || '0000',

  // Business info
  BUSINESS_NAME  : 'PINE&CO',
  BUSINESS_EMOJI : '🌲',
  BUSINESS_PHONE : process.env.BUSINESS_PHONE || '010-6817-0406',
  PUBLIC_URL     : process.env.PUBLIC_URL     || 'https://pineandco-reserve.onrender.com',
  BUSINESS_HOURS : '19:00 - 02:00',

  // SMS: Aligo (Korean numbers) — set in Render environment variables
  ALIGO_KEY      : process.env.ALIGO_KEY      || '',
  ALIGO_USER_ID  : process.env.ALIGO_USER_ID  || '',
  ALIGO_SENDER   : process.env.ALIGO_SENDER   || '',

  // KakaoTalk Alimtalk — set in Render environment variables
  KAKAO_SENDER_KEY : process.env.KAKAO_SENDER_KEY || '',
  TPL_JOIN   : process.env.TPL_JOIN   || '',
  TPL_CALL   : process.env.TPL_CALL   || '',
  TPL_CANCEL : process.env.TPL_CANCEL || '',

  // SMS: Twilio (International numbers) — set in Render environment variables
  TWILIO_SID     : process.env.TWILIO_SID     || '',
  TWILIO_TOKEN   : process.env.TWILIO_TOKEN   || process.env.TWILIO_AUTH || '',
  TWILIO_FROM    : process.env.TWILIO_FROM    || '',

  // Email: Gmail SMTP (primary) — set in Render environment variables
  GMAIL_USER     : process.env.GMAIL_USER || '',
  GMAIL_PASS     : process.env.GMAIL_PASS || '',
  EMAIL_FROM     : process.env.EMAIL_FROM || 'Pine & Co Seoul <onboarding@resend.dev>',

  // Email: Resend (fallback) — set in Render environment variables
  RESEND_API_KEY : process.env.RESEND_API_KEY || '',
  RESEND_FROM    : process.env.RESEND_FROM || '',

  // Waiting list auto-cancel timeout
  AUTO_CANCEL_MIN : parseInt(process.env.AUTO_CANCEL_MIN) || 5,

  // Google services (optional)
  GOOGLE_CLIENT_EMAIL : process.env.GOOGLE_CLIENT_EMAIL || '',
  GOOGLE_PRIVATE_KEY  : process.env.GOOGLE_PRIVATE_KEY  || '',
  GOOGLE_CALENDAR_ID  : process.env.GOOGLE_CALENDAR_ID  || '',
  GOOGLE_SHEET_ID     : process.env.GOOGLE_SHEET_ID     || '',

  // Sheets webhook (waiting check-in log)
  SHEETS_WEBHOOK : process.env.SHEETS_WEBHOOK || 'https://script.google.com/macros/s/AKfycbwjrCc045OGvWcHFyMXpW0yZLozPhRJgWIuimozptylSWYE9A-KS9o28PAC3NceNb7Dwg/exec',

  // ── Reservation system: seat rules (NEVER VIOLATE) ──
  SEATS: {
    bar        : ['B1','B2','B3','B4','B5','B6','B7','B8','B9','B10','B11','B12','B13','B14'],
    tables     : ['T1','T2','T3','T4'],
    highTables : ['H1','H2'],
    room       : ['ROOM'],
  },
  CAPACITY: { T1:5,T2:5,T3:5,T4:5,H1:2,H2:2,ROOM:10,B1:1,B2:1,B3:1,B4:1,B5:1,B6:1,B7:1,B8:1,B9:1,B10:1,B11:1,B12:1,B13:1,B14:1 },
  // ── Staff-reserved seats: NEVER offered to guests via auto-assign or customer.html ──
  // Used for emergencies, regulars, walk-ins. Staff can still manually assign these via manage.html.
  STAFF_RESERVED_SEATS : ['T1'],
  ROOM_MIN_CHARGE : 300000,
  BAR_EDGE_SEATS  : ['B1','B3','B4','B6'],
  BAR_MID_SEATS   : ['B2','B5'],
  BAR_U_SEATS     : ['B7','B8','B9','B10','B11','B12','B13','B14'],
  WEEKDAY_SLOTS   : ['19:00','20:00','21:00','23:00'],
  WEEKEND_SLOTS   : ['19:00','20:00','21:00'],
  LATE_SLOT       : '23:00',
  LATE_BAR_MAX    : 4,
  LATE_TABLE_MAX  : 2,
};

const IS_DEV          = !CONFIG.ALIGO_KEY || CONFIG.ALIGO_KEY === 'YOUR_API_KEY';
const IS_TWILIO_READY = CONFIG.TWILIO_SID !== 'YOUR_TWILIO_SID';
const IS_GMAIL_READY  = !!(CONFIG.GMAIL_USER && CONFIG.GMAIL_PASS);
const IS_RESEND_READY = !!(CONFIG.RESEND_API_KEY);
const IS_EMAIL_READY  = IS_GMAIL_READY || IS_RESEND_READY;

// ─────────────────────────────────────────────────────────────
//  DATA FILES — single DATA_DIR for both systems
// ─────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Reservation system files
const DATA_FILE     = path.join(DATA_DIR, 'reservations.json');
const EVENTS_FILE   = path.join(DATA_DIR, 'events.json');
const STAFF_FILE    = path.join(DATA_DIR, 'staff.json');
const VISITORS_FILE = path.join(DATA_DIR, 'visitors.json');
const BACKUP_DIR    = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Waiting system files
const QUEUE_FILE    = path.join(DATA_DIR, 'queue.json');
const QUEUE_BACKUP  = path.join(DATA_DIR, 'queue.backup.json');
const WAIT_HIST     = path.join(DATA_DIR, 'waiting_history.json');

// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────
// Reservation state
let reservations = [];
let events       = {};
let staffNames   = ['DuUi','Manager'];
let visitors     = [];

// Waiting state
let queue        = [];
let waitHistory  = [];   // today's completed/cancelled waiting entries
let cancelTimers = {};
let sseClients   = [];
let opLock       = false;

// Reservation operation lock
let lockPromise = Promise.resolve();
function withResLock(fn) {
  // CRITICAL FIX: previous version chained .catch(throw) which left lockPromise
  // permanently rejected after the first throw, causing ALL subsequent reservation
  // requests to fail with the same error until server restart.
  // New: caller gets the real result/error via `result`; the chain itself stays alive.
  const result = lockPromise.then(fn);
  lockPromise = result.catch(() => {}); // swallow rejection for the chain only
  return result;                         // caller still sees the actual error
}

// Waiting operation lock (spin-wait)
async function withQueueLock(fn) {
  let waited = 0;
  while (opLock) {
    await new Promise(r => setTimeout(r, 10));
    waited += 10;
    if (waited > 3000) { console.error('⚠️  Queue lock timeout — forcing unlock'); opLock = false; break; }
  }
  opLock = true;
  try { return await fn(); }
  finally { opLock = false; }
}

// ─────────────────────────────────────────────────────────────
//  DATA LOAD / SAVE
// ─────────────────────────────────────────────────────────────

// ── Reservation load ──
function loadReserveData() {
  try { if (fs.existsSync(DATA_FILE))     reservations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { reservations = []; }
  try { if (fs.existsSync(EVENTS_FILE))   events       = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch { events = {}; }
  try { if (fs.existsSync(STAFF_FILE))    staffNames   = JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8')); } catch {}
  try { if (fs.existsSync(VISITORS_FILE)) visitors     = JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf8')); } catch { visitors = []; }
  console.log(`📂 Data dir: ${DATA_DIR}`);
  console.log(`📦 Loaded ${reservations.length} reservations · ${visitors.length} visitors · ${Object.keys(events).length} events`);
}

function saveRes()       { try { fs.writeFileSync(DATA_FILE,     JSON.stringify(reservations, null, 2)); } catch(e) { console.error(e); } }
function saveEvents()    { try { fs.writeFileSync(EVENTS_FILE,   JSON.stringify(events,       null, 2)); } catch(e) { console.error(e); } }
function saveStaff()     { try { fs.writeFileSync(STAFF_FILE,    JSON.stringify(staffNames,   null, 2)); } catch(e) { console.error(e); } }
function saveVisitors()  { try { fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors,     null, 2)); } catch(e) { console.error(e); } }

// ── Reservation auto-backup (hourly) ──
function autoBackup() {
  try {
    const ts = new Date().toISOString().slice(0,13).replace(/[-:T]/g,'');
    fs.writeFileSync(path.join(BACKUP_DIR, 'res_'+ts+'.json'), JSON.stringify(reservations));
    const files = fs.readdirSync(BACKUP_DIR).sort();
    while (files.length > 48) { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); }
    console.log('💾 Backup: ' + reservations.length + ' reservations');
  } catch(e) { console.error('Backup error:', e.message); }
}

// ── Waiting queue: atomic save (temp file + rename) ──
function saveQueue() {
  const tmp = QUEUE_FILE + '.tmp';
  const data = JSON.stringify(queue, null, 2);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, QUEUE_FILE);
    fs.writeFileSync(QUEUE_BACKUP, data, 'utf8');
  } catch(e) {
    console.error('⚠️  Queue save error:', e.message);
    try { fs.writeFileSync(QUEUE_FILE, data, 'utf8'); } catch {}
  }
}
function saveWaitHist() {
  try { fs.writeFileSync(WAIT_HIST, JSON.stringify(waitHistory, null, 2), 'utf8'); }
  catch(e) { console.error('⚠️  Wait history save error:', e.message); }
}

function loadWaitHist() {
  try {
    if (fs.existsSync(WAIT_HIST)) {
      const d = JSON.parse(fs.readFileSync(WAIT_HIST, 'utf8'));
      if (Array.isArray(d)) waitHistory = d;
    }
  } catch { waitHistory = []; }
}

// ── Waiting queue load with validation + backup recovery ──
function loadQueue() {
  let raw = null;
  try { if (fs.existsSync(QUEUE_FILE)) raw = fs.readFileSync(QUEUE_FILE, 'utf8'); } catch { raw = null; }
  if (!raw || raw.trim() === '') {
    try { if (fs.existsSync(QUEUE_BACKUP)) raw = fs.readFileSync(QUEUE_BACKUP, 'utf8'); } catch { raw = null; }
  }
  if (!raw) { queue = []; return; }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Not an array');
    // Lenient validation: keep entries as long as they have the bare essentials.
    // phone or email can be missing/null (old format, or email-only registrations).
    queue = parsed.filter(e =>
      e && typeof e.id === 'string'
      && typeof e.name === 'string' && e.name.trim().length > 0
      && typeof e.status === 'string' && ['waiting','called'].includes(e.status)
      && typeof e.joinedAt === 'number'
    ).map(e => ({
      // Normalize fields so downstream code never hits undefined
      id: e.id,
      number: typeof e.number === 'number' ? e.number : (typeof e.number === 'string' ? parseInt(e.number) || 0 : 0),
      name: e.name.trim(),
      phone: typeof e.phone === 'string' ? e.phone : '',
      email: typeof e.email === 'string' ? e.email : null,
      partySize: typeof e.partySize === 'number' ? e.partySize : (parseInt(e.partySize) || 2),
      joinedAt: e.joinedAt,
      status: e.status,
      assignedSeat: e.assignedSeat || null,
      calledAt: typeof e.calledAt === 'number' ? e.calledAt : null,
      notifiedVia: e.notifiedVia || null,
    }));
    if (queue.length !== parsed.length) {
      console.warn(`⚠️  Removed ${parsed.length - queue.length} invalid entries from queue`);
      saveQueue();
    }
  } catch(e) {
    console.error('⚠️  CORRUPT queue.json, starting fresh:', e.message);
    queue = []; saveQueue();
  }
}

// ─────────────────────────────────────────────────────────────
//  VISITOR TRACKING (returning guest detection)
// ─────────────────────────────────────────────────────────────
function recordVisit(r) {
  if (!r.name || r.name === 'Guest') return;
  const clean = s => (s || '').replace(/[\s\-]/g, '').toLowerCase();
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
  appendToSheet(r, visitCount);
}

function checkReturning(name, phone, email, instagram) {
  const clean = s => (s || '').replace(/[\s\-]/g, '').toLowerCase();
  for (const v of visitors) {
    let matches = 0;
    if (v.name && name && v.name.toLowerCase() === name.toLowerCase()) matches++;
    if (v.phone && phone && clean(v.phone) === clean(phone)) matches++;
    if (v.email && email && v.email.toLowerCase() === email.toLowerCase()) matches++;
    if (v.instagram && instagram && v.instagram.toLowerCase() === instagram.toLowerCase()) matches++;
    if (matches >= 2) {
      const visitArr = Array.isArray(v.visits) ? v.visits : [];
      const zoneCounts = {};
      visitArr.forEach(vis => { if (vis && vis.zone) zoneCounts[vis.zone] = (zoneCounts[vis.zone]||0) + 1; });
      const prefZone = Object.keys(zoneCounts).sort((a,b) => zoneCounts[b] - zoneCounts[a])[0] || '';
      const recentVisits = visitArr.slice(-5).reverse().map(vis => (vis && vis.date ? vis.date : '') + ' ' + (vis && vis.zone ? vis.zone : ''));
      return {
        returning: visitArr.length > 0,
        visits: visitArr.length,
        lastVisit: v.lastVisit || '',
        firstVisit: v.firstVisit || '',
        prefZone, recentVisits,
      };
    }
  }
  return { returning: false };
}

// ─────────────────────────────────────────────────────────────
//  GOOGLE SHEETS INTEGRATION
// ─────────────────────────────────────────────────────────────

// ── Reservation visit log → Sheet1 (via googleapis) ──
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
    const now = new Date(Date.now() + 9 * 3600000);
    const row = [
      r.date, r.time || 'walkin', r.name, r.partySize,
      r.phone || '', r.email || '', r.instagram || '',
      r.zone || '', (r.seats || []).join(','),
      r.source || '',
      visitCount > 1 ? '재방문 (' + visitCount + '회)' : '신규',
      r.notes || '',
      now.toISOString().slice(0, 19).replace('T', ' '),
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:M',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    console.log('📊 [SHEETS] Added: ' + r.name + ' / ' + r.date);
  } catch (e) { console.error('📊 [SHEETS] Error:', e.message); }
}

// ── Reservation creation log → 예약로그 tab ──
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
      now.toISOString().slice(0, 19).replace('T', ' '),
      r.confirmCode || '', r.date, r.time, r.name, r.partySize,
      r.phone || '', r.email || '', r.instagram || '',
      r.zone || '', (r.seats || []).join(','),
      r.source || '', r.notes || '', r.status || 'confirmed',
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: '예약로그!A:N',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    console.log('📋 [LOG] ' + r.name + ' / ' + r.date + ' / ' + (r.confirmCode || 'no-code'));
  } catch (e) { console.error('📋 [LOG] Error:', e.message); }
}

// ── Waiting check-in log → Apps Script webhook (via HTTPS redirect follow) ──
function logWaitingCheckin(entry) {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const payload = JSON.stringify({
    name: entry.name,
    phone: entry.phone ? toE164(entry.phone) : '',
    email: entry.email || '',
    partySize: entry.partySize || 2,
    date: kst.toISOString().split('T')[0],
    time: kst.toISOString().split('T')[1].slice(0,5),
    number: entry.number,
  });
  function postWithRedirect(targetUrl, body) {
    const u = new URL(targetUrl);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, (r2) => {
          let b=''; r2.on('data',d=>b+=d); r2.on('end',()=>console.log(`📊 Sheets saved: ${entry.name}`));
        }).on('error', e => console.error('Sheets redirect error:', e.message));
      } else {
        let b=''; res.on('data',d=>b+=d); res.on('end',()=>console.log(`📊 Sheets: ${b.slice(0,80)}`));
      }
    });
    req.on('error', e => console.error('Sheets error:', e.message));
    req.write(body); req.end();
  }
  postWithRedirect(CONFIG.SHEETS_WEBHOOK, payload);
}

// ─────────────────────────────────────────────────────────────
//  PHONE UTILITIES
// ─────────────────────────────────────────────────────────────
function isKoreanNumber(phone) {
  if (!phone) return false;
  const clean = String(phone).replace(/[^0-9+]/g, '');
  // ── Korean country code patterns ──
  if (clean.startsWith('+82')) return true;     // +82-10-...
  if (clean.startsWith('+820')) return true;    // +820-10-... (typo)
  if (clean.startsWith('820')) return true;     // 82010... (no plus)
  if (clean.startsWith('82') && clean.length >= 11) return true;
  // ── Local Korean patterns (no country code) ──
  if (/^01[0-9]/.test(clean)) return true;      // 010, 011, 016, 017, 018, 019
  if (/^0[2-6][0-9]/.test(clean)) return true;  // 02-09xx (regional landline)
  if (/^070/.test(clean)) return true;          // 070 (internet phone)
  return false;
}

function toE164(phone) {
  let clean = String(phone || '').replace(/[^0-9+]/g, '');
  // Fix common typo: +820... → +82...
  if (clean.startsWith('+820')) clean = '+82' + clean.slice(4);
  if (clean.startsWith('820') && !clean.startsWith('+')) clean = '+82' + clean.slice(3);
  if (clean.startsWith('+')) return clean;
  // Korean local patterns
  if (/^01[0-9]/.test(clean)) return '+82' + clean.slice(1);
  if (/^0[2-6]/.test(clean))  return '+82' + clean.slice(1);
  if (/^070/.test(clean))     return '+82' + clean.slice(1);
  // Foreign with country code, no +
  if (/^[1-9]\d{6,14}$/.test(clean)) return '+' + clean;
  return '+' + clean;
}

function toKoreanDomestic(phone) {
  let clean = String(phone || '').replace(/[^0-9+]/g, '');
  // Strip +82 or 82 prefix (handle +820 typo too)
  clean = clean.replace(/^\+?820?/, '');
  if (!clean.startsWith('0')) clean = '0' + clean;
  return clean;
}

// ─────────────────────────────────────────────────────────────
//  HTTP POST helper (for Aligo)
// ─────────────────────────────────────────────────────────────
function httpPost(hostname, reqPath, params) {
  const body = qs.stringify(params);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: reqPath, method: 'POST',
      headers: {
        'Content-Type'   : 'application/x-www-form-urlencoded',
        'Content-Length' : Buffer.byteLength(body),
      },
    }, res => {
      let buf = '';
      res.on('data', d => (buf += d));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ─────────────────────────────────────────────────────────────
//  SMS SENDERS
// ─────────────────────────────────────────────────────────────

// ── Twilio (international) ──
async function sendTwilio(toPhone, message) {
  const sid = CONFIG.TWILIO_SID, token = CONFIG.TWILIO_TOKEN, from = CONFIG.TWILIO_FROM;
  const body = qs.stringify({ To: toPhone, From: from, Body: message });
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${sid}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type'   : 'application/x-www-form-urlencoded',
        'Content-Length' : Buffer.byteLength(body),
        'Authorization'  : `Basic ${auth}`,
      },
    }, res => {
      let buf = '';
      res.on('data', d => (buf += d));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Simple SMS routing (for reservation confirmations/reminders) ──
function sendSMS(to, msg) {
  const cleaned = (to || '').replace(/[^0-9+]/g, '');
  if (!cleaned) return;
  if (isKoreanNumber(cleaned)) {
    if (!CONFIG.ALIGO_KEY) { console.log('📱 [ALIGO SIM] '+cleaned+'\n'+msg+'\n'); return; }
    httpPost('apis.aligo.in', '/send/', {
      key: CONFIG.ALIGO_KEY, user_id: CONFIG.ALIGO_USER_ID,
      sender: CONFIG.ALIGO_SENDER, receiver: toKoreanDomestic(cleaned),
      msg, msg_type: 'LMS',
    }).then(d => console.log('Aligo:', JSON.stringify(d).slice(0,100)))
      .catch(e => console.error('Aligo error:', e.message));
  } else {
    if (!IS_TWILIO_READY) { console.log('📱 [TWILIO SIM] '+cleaned+'\n'+msg+'\n'); return; }
    sendTwilio(toE164(cleaned), msg)
      .then(d => console.log('Twilio:', d?.sid || d?.message))
      .catch(e => console.error('Twilio error:', e.message));
  }
}

// ─────────────────────────────────────────────────────────────
//  EMAIL (Resend or Gmail SMTP)
// ─────────────────────────────────────────────────────────────
let gmailTransport = null;
if (IS_GMAIL_READY) {
  gmailTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: CONFIG.GMAIL_USER, pass: CONFIG.GMAIL_PASS },
  });
  gmailTransport.verify()
    .then(() => console.log('✅ Gmail SMTP connection verified'))
    .catch(err => console.error('❌ Gmail SMTP connection FAILED:', err.message));
}

async function sendEmailViaResend(toEmail, subject, htmlBody) {
  const fromAddr = CONFIG.RESEND_FROM || CONFIG.EMAIL_FROM || 'onboarding@resend.dev';
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: fromAddr, to: [toEmail], subject, html: htmlBody });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let buf = '';
      res.on('data', d => (buf += d));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✅ Resend sent → ${toEmail} (${parsed.id || 'ok'})`);
            resolve(parsed);
          } else {
            console.error(`❌ Resend FAILED → ${toEmail}: ${buf}`);
            resolve(null);
          }
        } catch {
          console.error(`❌ Resend parse error → ${toEmail}: ${buf}`);
          resolve(null);
        }
      });
    });
    req.on('error', err => {
      console.error(`❌ Resend error → ${toEmail}: ${err.message}`);
      resolve(null);
    });
    req.write(body); req.end();
  });
}

async function sendEmail(toEmail, subject, htmlBody) {
  // Prefer Resend (if configured), fallback to Gmail
  if (IS_RESEND_READY) {
    const result = await sendEmailViaResend(toEmail, subject, htmlBody);
    if (result) return result;
    // If Resend failed and Gmail is available, try Gmail
    if (!gmailTransport) return null;
  }
  if (!gmailTransport) {
    if (!IS_RESEND_READY) console.log('⚠️  Email not configured, skipping');
    return null;
  }
  try {
    const result = await gmailTransport.sendMail({
      from: CONFIG.EMAIL_FROM, replyTo: CONFIG.GMAIL_USER,
      to: toEmail, subject, html: htmlBody,
    });
    console.log(`✅ Gmail sent → ${toEmail} (${result.messageId})`);
    return result;
  } catch (err) {
    console.error(`❌ Gmail send FAILED → ${toEmail}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  WAITING SYSTEM: Email templates + notification routing
// ─────────────────────────────────────────────────────────────
function buildWaitEmailHTML(type, entry, url, extra) {
  const min = CONFIG.AUTO_CANCEL_MIN;
  const biz = CONFIG.BUSINESS_PHONE;
  const btnStyle = 'display:inline-block;padding:16px 44px;background:#b8935a;color:#1e1208;text-decoration:none;border-radius:8px;font-family:Georgia,serif;font-size:14px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;';
  const dividerStyle = 'border:none;border-top:1px solid rgba(184,147,90,.25);margin:28px auto;width:60px;';

  const templates = {
    join: {
      subject: `🌲 Pine & Co — You're on the waitlist (#${entry.number})`,
      body: `
        <p style="color:#c9a96e;font-size:13px;letter-spacing:2px;margin:0 0 24px;">YOU'RE ON THE LIST</p>
        <p style="color:#f0ebe0;font-size:15px;line-height:1.7;margin:0 0 8px;">Welcome, <strong style="color:#c9a96e;">${entry.name}</strong>.</p>
        <p style="color:#a89478;font-size:13px;line-height:1.7;margin:0 0 24px;">Thank you for choosing Pine &amp; Co.<br>파인앤코를 찾아주셔서 감사합니다.</p>

        <div style="font-family:Georgia,serif;font-size:64px;color:#b8935a;font-weight:300;margin:24px 0 4px;letter-spacing:-2px;">#${entry.number}</div>
        <p style="color:#a89478;font-size:12px;letter-spacing:2px;margin:0 0 8px;">YOUR NUMBER</p>
        <p style="color:#c9a96e;font-size:13px;margin:8px 0 28px;">${entry.partySize||2} guest${(entry.partySize||2)>1?'s':''} · ${(extra.myPos||1)-1===0?'You\'re next!':`${(extra.myPos||1)-1} ahead of you / 앞에 ${(extra.myPos||1)-1}팀`}</p>

        <p style="margin:28px 0;"><a href="${url}" style="${btnStyle}">Check Your Status</a></p>

        <hr style="${dividerStyle}"/>

        <p style="color:#a89478;font-size:13px;line-height:1.7;margin:0;">
          We'll let you know the moment your table is ready.<br>
          <span style="color:#7a6550;font-size:12px;">자리가 준비되면 바로 안내드리겠습니다.</span>
        </p>`,
    },
    call: {
      subject: `🌲 Pine & Co — Your table is ready`,
      body: `
        <p style="color:#c9a96e;font-size:13px;letter-spacing:2px;margin:0 0 16px;">YOUR TABLE IS READY</p>
        <div style="font-family:Georgia,serif;font-size:36px;color:#b8935a;font-weight:300;margin:8px 0 24px;letter-spacing:-1px;line-height:1.2;">Welcome,<br>${entry.name}.</div>

        <p style="color:#f0ebe0;font-size:15px;line-height:1.7;margin:0 0 8px;">Your table is now ready.</p>
        <p style="color:#a89478;font-size:13px;line-height:1.7;margin:0 0 28px;">
          We kindly ask you to arrive within <strong style="color:#c9a96e;">${min} minutes</strong>.<br>
          <span style="color:#7a6550;">${min}분 내로 방문 부탁드리겠습니다.</span>
        </p>

        <p style="margin:28px 0;"><a href="${url}" style="${btnStyle}">View Details</a></p>

        <hr style="${dividerStyle}"/>

        <p style="color:#a89478;font-size:13px;line-height:1.7;margin:0 0 12px;">
          Need a little more time?<br>
          <span style="color:#7a6550;font-size:12px;">시간이 더 필요하시면 편하게 연락 부탁드립니다.</span>
        </p>
        <p style="color:#c9a96e;font-size:16px;font-weight:500;margin:8px 0 0;">📞 ${biz}</p>`,
    },
    cancel: {
      subject: `Pine & Co — Your spot has been released`,
      body: `
        <p style="color:#c9a96e;font-size:13px;letter-spacing:2px;margin:0 0 24px;">SPOT RELEASED</p>
        <p style="color:#f0ebe0;font-size:15px;line-height:1.7;margin:0 0 8px;">Hello, <strong style="color:#c9a96e;">${entry.name}</strong>.</p>
        <p style="color:#a89478;font-size:13px;line-height:1.7;margin:0 0 24px;">
          As we didn't hear back within ${min} minutes, your spot has been released.<br>
          <span style="color:#7a6550;">${min}분이 경과하여 웨이팅이 자동 취소되었습니다.</span>
        </p>

        <p style="color:#f0ebe0;font-size:14px;line-height:1.7;margin:24px 0;">
          We'd love to have you visit again — feel free to register anytime.<br>
          <span style="color:#a89478;font-size:12px;">언제든 다시 등록해 주시면 모시겠습니다.</span>
        </p>

        <hr style="${dividerStyle}"/>

        <p style="color:#c9a96e;font-size:16px;font-weight:500;margin:8px 0 0;">📞 ${biz}</p>`,
    },
  };
  const t = templates[type];
  return {
    subject: t.subject,
    html: `<div style="background:#0f0a06;padding:32px 16px;font-family:Georgia,serif;">
      <div style="max-width:520px;margin:0 auto;background:#1e1208;color:#f0ebe0;padding:48px 32px;text-align:center;border-radius:14px;border:1px solid rgba(184,147,90,.15);box-shadow:0 8px 32px rgba(0,0,0,.4);">
        <div style="font-family:Georgia,serif;font-size:14px;letter-spacing:5px;color:#b8935a;margin-bottom:8px;font-weight:300;">PINE &amp; CO</div>
        <div style="font-family:Georgia,serif;font-size:9px;letter-spacing:3px;color:#7a6550;margin-bottom:36px;">SEOUL · COCKTAIL BAR</div>
        ${t.body}
        <hr style="border:none;border-top:1px solid rgba(184,147,90,.15);margin:36px 0 16px;"/>
        <p style="font-size:10px;color:#5a4530;letter-spacing:1px;margin:0;line-height:1.6;">Pine &amp; Co Seoul · 010-6817-0406<br>You're receiving this because you joined our waiting list.</p>
      </div>
    </div>`,
  };
}

// ── Helper: convert Korean name to 'Guest' to keep SMS in 1 segment (GSM-7) ──
// SMS billing: any non-ASCII char forces UCS-2 (70 chars/seg vs 160). Foreign names = personalized, Korean names = 'Guest'.
function asciiName(name) {
  if (!name) return 'Guest';
  return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(name) ? 'Guest' : name;
}

// ── Unified waiting notification (Aligo/Twilio + email) ──
async function sendWaitingMessage(entry, type, extra = {}) {
  const rawPhone = (entry.phone || '').replace(/-/g, '');
  const url = `${CONFIG.PUBLIC_URL}/t/${entry.id}`;
  const min = CONFIG.AUTO_CANCEL_MIN;
  const biz = CONFIG.BUSINESS_PHONE;

  const messages = {
    join: {
      tpl  : CONFIG.TPL_JOIN,
      vars : { '#{이름}': entry.name, '#{번호}': String(entry.number),
               '#{순서}': String(extra.myPos || 1), '#{전체대기}': String(extra.total || 1),
               '#{링크}': url },
      // Twilio (foreign): 1-segment English
      sms  : `PINE&CO: Hi ${asciiName(entry.name)}, you are #${entry.number}. ${(extra.myPos||1)-1===0?"You're next!":`${(extra.myPos||1)-1} ahead of you.`} Track: ${url}`,
      // Aligo (Korean LMS, no segment limit): full bilingual message
      smsKr: `[PINE&CO]\n`
           + `파인앤코에 방문해주셔서 감사합니다.\n`
           + `웨이팅 ${entry.number}번 (${entry.partySize||2}명) 등록되었습니다.\n`
           + `자리가 나면 문자로 알려드리겠습니다.\n`
           + `\n`
           + `Thank you for visiting Pine & Co.\n`
           + `You are #${entry.number} (${entry.partySize||2} guests).\n`
           + `We'll notify you when your table is ready.\n`
           + `\n`
           + `대기 / Waiting: ${(extra.myPos||1)-1===0?"다음 차례입니다 / You're next":`앞에 ${(extra.myPos||1)-1}팀 / ${(extra.myPos||1)-1} ahead`}\n`
           + `${url}\n`
           + `Tel: ${biz}`,
    },
    call: {
      tpl  : CONFIG.TPL_CALL,
      vars : { '#{이름}': entry.name, '#{번호}': String(entry.number),
               '#{분}': String(min), '#{링크}': url },
      sms  : `PINE&CO: #${entry.number} ${asciiName(entry.name)}, your table is ready. Arrive in ${min} min. ${url}`,
      smsKr: `[PINE&CO]\n`
           + `${entry.name}님, 자리가 준비되었습니다!\n`
           + `웨이팅 ${entry.number}번 / ${min}분 내 방문 부탁드립니다.\n`
           + `\n`
           + `${entry.name}, your table is ready!\n`
           + `Waiting #${entry.number}\n`
           + `Please arrive within ${min} minutes.\n`
           + `\n`
           + `${url}\n`
           + `Tel: ${biz}`,
    },
    cancel: {
      tpl  : CONFIG.TPL_CANCEL,
      vars : { '#{이름}': entry.name, '#{분}': String(min) },
      sms  : `PINE&CO: #${entry.number} ${asciiName(entry.name)}, your spot expired after ${min} min. Please register again.`,
      smsKr: `[PINE&CO]\n`
           + `${entry.name}님, ${min}분이 지나\n`
           + `웨이팅이 자동 취소되었습니다.\n`
           + `재등록은 언제든 가능합니다.\n`
           + `\n`
           + `${entry.name}, your spot was released\n`
           + `after ${min} minutes.\n`
           + `You're welcome to register again.\n`
           + `\n`
           + `Tel: ${biz}`,
    },
  };

  const m = messages[type];
  const korean = rawPhone ? isKoreanNumber(entry.phone) : false;
  const label  = { join:'REGISTER', call:'NOTIFY', cancel:'AUTO-CANCEL' }[type];
  const krPhone = korean ? toKoreanDomestic(rawPhone) : rawPhone;

  // Email (parallel with SMS)
  if (entry.email && IS_EMAIL_READY) {
    const emailData = buildWaitEmailHTML(type, entry, url, extra);
    sendEmail(entry.email, emailData.subject, emailData.html).catch(() => {});
  }

  // No phone → email only
  if (!rawPhone) { console.log(`📧 [${label}] Email only → ${entry.email}`); return; }

  if (IS_DEV && !IS_TWILIO_READY) {
    console.log(`\n🟡 [${label} simulation] ${korean ? 'KR' : 'INTL'}`);
    console.log(`   To: ${krPhone} (${entry.name})`);
    console.log(`   Msg: ${m.sms}\n`);
    return;
  }

  // Korean → Aligo (try Alimtalk first, SMS fallback)
  if (korean) {
    if (IS_DEV) { console.log(`\n🟡 [${label} KR simulation] ${krPhone}\n   ${m.smsKr}\n`); return; }
    const hasKakao = CONFIG.KAKAO_SENDER_KEY && CONFIG.KAKAO_SENDER_KEY.length > 0
                  && CONFIG.KAKAO_SENDER_KEY !== 'YOUR_SENDER_KEY'
                  && m.tpl && m.tpl.length > 0
                  && m.tpl !== `YOUR_TPL_CODE_${type.toUpperCase()}`;
    if (hasKakao) {
      let tplMsg = Object.entries(m.vars).reduce((s, [k, v]) => s.replaceAll(k, v), m.smsKr);
      try {
        const result = await httpPost('kakaoapi.aligo.in', '/akv10/alimtalk/send/', {
          apikey: CONFIG.ALIGO_KEY, userid: CONFIG.ALIGO_USER_ID,
          senderkey: CONFIG.KAKAO_SENDER_KEY, tpl_code: m.tpl,
          sender: CONFIG.ALIGO_SENDER, receiver_1: krPhone,
          recvname_1: entry.name, message_1: tplMsg,
          failover: 'Y', fsubject_1: 'PINE&CO Waiting',
          fmessage_1: m.smsKr, fmsg_type: 'LMS',
        });
        // Check for senderkey error and fall through to SMS
        if (result && typeof result === 'object' && result.code !== undefined && result.code < 0) {
          console.error(`Alimtalk failed (code ${result.code}), falling back to SMS:`, result.message);
        } else {
          console.log(`✅ Alimtalk sent (${type}):`, result?.message || result?.result_code);
          return result;
        }
      } catch (e) { console.error('Alimtalk error, falling back to SMS:', e.message); }
    }
    try {
      const result = await httpPost('apis.aligo.in', '/send/', {
        key: CONFIG.ALIGO_KEY, user_id: CONFIG.ALIGO_USER_ID,
        sender: CONFIG.ALIGO_SENDER, receiver: krPhone,
        msg: m.smsKr, msg_type: 'LMS',
      });
      console.log(`✅ KR SMS sent (${type}):`, JSON.stringify(result));
      return result;
    } catch (e) { console.error('KR SMS error:', e.message); }
  }
  // International → Twilio
  else {
    const e164 = toE164(entry.phone);
    // 🛡️ Safety guard: block Korean numbers from leaking to Twilio
    if (e164.startsWith('+82') || e164.startsWith('+820')) {
      console.error(`🚨 BLOCKED: Korean number leaked to Twilio route → ${e164}. Should use Aligo. Skipping SMS.`);
      return { error: 'korean_number_blocked' };
    }
    // 💰 Cost optimization: Skip ALL international SMS — high cost + low delivery rate.
    // We rely on email for all foreign guests. Korean numbers handled above via Aligo.
    const hasEmail = entry.email && entry.email.length > 0;
    console.log(`💌 SKIPPED: International SMS → ${e164} (using email instead${hasEmail ? '' : ' — but no email on file!'})`);
    return { skipped: 'foreign_email_only', country: e164.substring(0, 4), hasEmail };
    // ── Below code is unreachable but kept for reference ──
    if (!IS_TWILIO_READY) { console.log(`\n🟡 [${label} INTL simulation] → ${e164}\n   ${m.sms}\n`); return; }
    try {
      const result = await sendTwilio(e164, m.sms);
      if (result?.sid) console.log(`✅ Twilio sent (${type}) → ${e164}: SID ${result.sid}`);
      else console.error(`⚠️  Twilio response (${type}):`, JSON.stringify(result));
      return result;
    } catch (e) { console.error('Twilio error:', e.message); }
  }
}

// ─────────────────────────────────────────────────────────────
//  RESERVATION SYSTEM: Email templates + confirmation
// ─────────────────────────────────────────────────────────────
function buildReserveConfirmHTML(r) {
  const zoneKR = { bar:'바 좌석', table:'테이블', highTable:'하이테이블', room:'프라이빗 룸' };
  const zoneName = zoneKR[r.zone] || r.zone;
  const roomNote = r.zone === 'room'
    ? `<div style="background:rgba(184,147,90,.12);border:1px solid rgba(184,147,90,.35);border-radius:8px;padding:16px;margin-top:14px;">
         <p style="font-size:13px;color:#c9a96e;font-weight:600;margin:0 0 8px;letter-spacing:.05em;">🎩 PRIVATE ROOM</p>
         <p style="font-size:12px;color:#f0ebe0;line-height:1.6;margin:0 0 8px;">
           <strong style="color:#c9a96e;">Minimum spend: ₩300,000</strong><br>
           This reservation is <strong>non-refundable</strong> and cannot be changed once confirmed.<br>
           If your party size or plans change, please call us directly.
         </p>
         <hr style="border:none;border-top:1px solid rgba(184,147,90,.25);margin:8px 0;">
         <p style="font-size:12px;color:#f0ebe0;line-height:1.6;margin:0;">
           <strong style="color:#c9a96e;">최소 이용 금액: 30만원</strong><br>
           본 예약은 확정 후 변경 또는 취소 시 <strong>환불이 불가</strong>합니다.<br>
           인원 변동이 있으시면 매장으로 직접 연락 부탁드립니다.
         </p>
       </div>` : '';
  return `
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
}

function sendReserveConfirmation(r) {
  const msg = `[PINE&CO] ${r.name}님, 예약이 확인되었습니다.\n날짜: ${r.date} ${r.time}\n인원: ${r.partySize}명\n취소는 전화로만: ${CONFIG.BUSINESS_PHONE}\n\n[PINE&CO] Confirmed.\n${r.date} ${r.time} / Party: ${r.partySize}\nTo cancel: ${CONFIG.BUSINESS_PHONE}`;
  if (r.phone) sendSMS(r.phone, msg);
  if (r.email && IS_EMAIL_READY) {
    sendEmail(r.email, `[PINE&CO] Reservation Confirmed — ${r.date} ${r.time}`, buildReserveConfirmHTML(r)).catch(()=>{});
  }
}

// ── Reminders (D-1, D-0) ──
function sendReminders() {
  const today = kstToday();
  const tmrw  = new Date(Date.now()+9*3600000+86400000).toISOString().slice(0,10);
  reservations.forEach(r => {
    if (r.status !== 'confirmed') return;
    if (r.date === tmrw && !r.reminderD1) {
      const msg = `[PINE&CO] ${r.name}님, 내일 예약 확인: ${r.date} ${r.time} / ${r.partySize}명\n변경/취소: ${CONFIG.BUSINESS_PHONE}`;
      if (r.phone) sendSMS(r.phone, msg);
      if (r.email && IS_EMAIL_READY) {
        sendEmail(r.email, `[PINE&CO] Tomorrow's Reservation — ${r.date} ${r.time}`, buildReserveConfirmHTML(r)).catch(()=>{});
      }
      r.reminderD1 = true; saveRes();
    }
    if (r.date === today && !r.reminderD0) {
      const msg = `[PINE&CO] ${r.name}님, 오늘 예약 확인: ${r.time} / ${r.partySize}명\n오늘 뵙겠습니다!`;
      if (r.phone) sendSMS(r.phone, msg);
      if (r.email && IS_EMAIL_READY) {
        sendEmail(r.email, `[PINE&CO] Today's Reservation — ${r.time}`, buildReserveConfirmHTML(r)).catch(()=>{});
      }
      r.reminderD0 = true; saveRes();
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  WAITING SYSTEM: queue helpers, SSE, history
// ─────────────────────────────────────────────────────────────
function nextNumber() {
  const used = new Set(queue.map(q => q.number));
  let n = queue.reduce((m, q) => Math.max(m, q.number), 0) + 1;
  while (used.has(n)) n++;
  return n;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function broadcastQueue() {
  const payload = JSON.stringify({ queue, history: waitHistory });
  sseClients = sseClients.filter(r => !r.writableEnded);
  sseClients.forEach(r => { try { r.write(`data: ${payload}\n\n`); } catch {} });
  saveQueue();
}

function moveToWaitHistory(entry, outcome) {
  const h = { ...entry, outcome, completedAt: Date.now() };
  waitHistory.push(h);
  saveWaitHist();
  console.log(`📋 Wait history: ${entry.name} (#${entry.number}) → ${outcome}`);
  if (outcome === 'checked_in') logWaitingCheckin(entry);
}

function startCancelTimer(id) {
  if (cancelTimers[id]) clearTimeout(cancelTimers[id]);
  cancelTimers[id] = setTimeout(async () => {
    await withQueueLock(async () => {
      const entry = queue.find(q => q.id === id);
      if (!entry || entry.status !== 'called') return;
      try { await sendWaitingMessage(entry, 'cancel'); } catch(e) { console.error(e); }
      moveToWaitHistory(entry, 'auto_cancelled');
      queue = queue.filter(q => q.id !== id);
      delete cancelTimers[id];
      broadcastQueue();
      console.log(`⏰ Auto-cancel (${CONFIG.AUTO_CANCEL_MIN} min): ${entry.name} (#${entry.number})`);
    });
  }, CONFIG.AUTO_CANCEL_MIN * 60 * 1000);
}

function recoverTimers() {
  const now = Date.now();
  queue.forEach(e => {
    if (e.status === 'called' && e.calledAt) {
      const elapsed = now - e.calledAt;
      const remaining = (CONFIG.AUTO_CANCEL_MIN * 60 * 1000) - elapsed;
      if (remaining <= 0) {
        console.log(`⏰ Expired during downtime: ${e.name} (#${e.number})`);
        queue = queue.filter(q => q.id !== e.id);
      } else {
        console.log(`🔄 Recovering timer for ${e.name} (#${e.number}), ${Math.ceil(remaining/1000)}s left`);
        startCancelTimer(e.id);
      }
    }
  });
  if (queue.length > 0) saveQueue();
}

// ── Daily 2AM KST reset (waiting queue + history only; reservations unaffected) ──
// Business hours: 7PM - 2AM. So waiting list is valid from 7PM until the next day 2AM.
// At 2AM, everything resets for a clean slate.
function scheduleDailyReset() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  // 2AM KST = 17:00 UTC (previous day)
  // Compute next 2AM KST moment
  const nextReset = new Date(kstNow);
  nextReset.setUTCHours(17, 0, 0, 0); // 2AM KST = 17:00 UTC
  // If current KST time is already past 2AM today, schedule for tomorrow's 2AM
  if (kstNow.getUTCHours() >= 17) {
    nextReset.setUTCDate(nextReset.getUTCDate() + 1);
  }
  const ms = nextReset.getTime() - kstNow.getTime();
  console.log(`⏰ Waiting-only daily reset (2AM KST) scheduled in ${Math.round(ms/1000/60)} minutes`);
  setTimeout(() => {
    console.log('🔄 Daily 2AM KST reset — clearing waiting queue and waiting history');
    Object.keys(cancelTimers).forEach(id => { clearTimeout(cancelTimers[id]); delete cancelTimers[id]; });
    queue = [];
    waitHistory = [];
    saveQueue();
    saveWaitHist();
    broadcastQueue();
    scheduleDailyReset();
  }, ms);
}

// ─────────────────────────────────────────────────────────────
//  RESERVATION SYSTEM: availability, auto-assign
// ─────────────────────────────────────────────────────────────
function kstToday() { return new Date(Date.now() + 9*3600000).toISOString().slice(0,10); }
function isWeekend(d) { const day = new Date(d+'T12:00:00+09:00').getDay(); return day===5 || day===6; }
// ── New Sunday-as-weekend rule: applies from June 1, 2026 onward ──
// Before June 1: legacy behavior (Sun = weekday, allows 23:00) — protects existing May reservations
// From June 1: Sunday treated as weekend (no 23:00 slot)
function isWeekendForSlots(d) {
  const day = new Date(d+'T12:00:00+09:00').getDay();
  if (day===5 || day===6) return true; // Fri, Sat always weekend
  if (day===0 && d >= '2026-06-01') return true; // Sun: weekend from June 1
  return false;
}
function getSlots(d) { return isWeekendForSlots(d) ? CONFIG.WEEKEND_SLOTS : CONFIG.WEEKDAY_SLOTS; }
function getResFor(date, time) {
  return reservations.filter(r => r.date===date && r.time===time && r.status!=='cancelled' && r.status!=='noshow');
}
// Slot grouping for overbooking prevention.
// Dinner slots (19/20/21) share seats — booking one occupies seats for ALL three.
// (Customers stay ~2 hours, so 19:00 customer is still at the table at 20:00.)
// Late-night slot (23:00) is independent — by then dinner is over.
const DINNER_SLOTS = ['19:00', '20:00', '21:00'];

function getOccupiedFor(date, time) {
  // CRITICAL: seat is occupied if ANY reservation in the same slot group exists.
  // Past bug: returned ALL occupied seats for the entire date (caused false "fully booked").
  // Newer bug (June bug): time-only filter allowed OVERBOOKING (19:00 and 20:00 same seat).
  // Current fix: group dinner slots together; late slot stays independent.
  const reqIsDinner = DINNER_SLOTS.includes(time);
  const s = [];
  reservations
    .filter(r => {
      if (r.date !== date) return false;
      if (r.status === 'cancelled' || r.status === 'noshow') return false;
      if (r.status !== 'confirmed' && r.status !== 'seated' && r.status !== 'needs_assignment') return false;
      const resIsDinner = DINNER_SLOTS.includes(r.time);
      // Both dinner → share seats (block overbooking)
      if (reqIsDinner && resIsDinner) return true;
      // Both late (or any same-time non-dinner) → only same time
      return r.time === time;
    })
    .forEach(r => { if (r.seats) s.push(...r.seats); });
  return s;
}
// Legacy alias — uses date-only (kept only for /api/debug endpoint)
function getOccupiedForDate(date) {
  const s = [];
  reservations
    .filter(r => r.date===date && (r.status==='confirmed' || r.status==='seated' || r.status==='needs_assignment'))
    .forEach(r => { if (r.seats) s.push(...r.seats); });
  return s;
}

function autoAssign(date, time, partySize, preference) {
  // ═══ STRICT SEAT RULES — NEVER VIOLATE ═══
  const occ = getOccupiedFor(date, time);  // FIX: time-aware occupancy
  const staffReserved = CONFIG.STAFF_RESERVED_SEATS || [];
  // Treat staff-reserved seats as occupied for guest auto-assign (staff can still book manually)
  const free = s => !occ.includes(s) && !staffReserved.includes(s);
  const freeBar   = CONFIG.SEATS.bar.filter(free);
  const freeHigh  = CONFIG.SEATS.highTables.filter(free);
  const freeTables = CONFIG.SEATS.tables.filter(free);
  const freeRoom  = free('ROOM');

  // 1명: 바 → 하이
  if (partySize === 1) {
    for (const s of CONFIG.BAR_EDGE_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
    for (const s of CONFIG.BAR_U_SEATS)    if (free(s)) return { zone:'bar', seats:[s] };
    for (const s of CONFIG.BAR_MID_SEATS)  if (free(s)) return { zone:'bar', seats:[s] };
    if (freeHigh.length > 0) return { zone:'highTable', seats:[freeHigh[0]] };
    return null;
  }
  // 2명: 인접한 바 페어만 (떨어진 좌석 절대 금지) → 하이테이블 → 없으면 null
  // 바 구조:
  //   백바: B1-B2-B3 한 블록 · B4-B5-B6 한 블록 (B3-B4 떨어짐)
  //   ㄷ자: B7-B8-B9-B10-B11-B12-B13-B14 (코너 포함 전부 인접)
  if (partySize === 2) {
    const barPairs = [
      ['B1','B2'], ['B2','B3'],                          // 백바 좌측 블록
      ['B4','B5'], ['B5','B6'],                          // 백바 우측 블록 (B3-B4 끊김)
      ['B7','B8'], ['B8','B9'], ['B9','B10'],            // ㄷ자 좌측 + 코너
      ['B10','B11'],                                     // ㄷ자 아래
      ['B11','B12'], ['B12','B13'], ['B13','B14'],       // ㄷ자 우측 + 코너
    ];
    for (const p of barPairs) if (p.every(free)) return { zone:'bar', seats:p };
    if (freeHigh.length > 0) return { zone:'highTable', seats:[freeHigh[0]] };
    // ⛔ NO fallback: never assign non-adjacent bar seats to a 2-person party
    return null;
  }
  // 3~5: 테이블만
  if (partySize >= 3 && partySize <= 5) {
    for (const s of freeTables) return { zone:'table', seats:[s] };
    return null;
  }
  // 6~10: 룸만
  if (partySize >= 6 && partySize <= 10) {
    if (freeRoom) return { zone:'room', seats:['ROOM'], note: '30만원 minimum charge' };
    return null;
  }
  return null;
}

function detectPreference(text, partySize) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(bar|바|바좌석|바석)\b/.test(t)) return 'bar';
  if (/\b(room|룸|프라이빗|private)\b/.test(t)) return 'room_request';
  if (/\b(table|테이블|테이블석)\b/.test(t)) return 'table';
  return null;
}

// ─────────────────────────────────────────────────────────────
//  Load initial data
// ─────────────────────────────────────────────────────────────
loadReserveData();
loadQueue();
loadWaitHist();

// Auto-migrate old data (reservation side — preserved from original)
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
    if (fs.existsSync(target) && fs.statSync(target).size > 10) return;
    for (const old of oldPaths) {
      const src = path.join(old, file);
      if (old === DATA_DIR) continue;
      if (fs.existsSync(src) && fs.statSync(src).size > 10) {
        try { fs.copyFileSync(src, target); console.log('📦 Migrated: '+src+' → '+target); }
        catch(e) { console.error('Migration error:', e.message); }
        break;
      }
    }
  });
}
if (process.env.DATA_DIR) migrateData();

// ═════════════════════════════════════════════════════════════
//  EXPRESS APP
// ═════════════════════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Default route → reservation booking page (guest-facing primary)
app.get('/', (_req, res) => res.redirect('/reserve.html'));

// Short URL for waiting SMS links
app.get('/t/:id', (req, res) => res.redirect('/customer.html?id=' + req.params.id));

// ─────────────────────────────────────────────────────────────
//  SHARED APIs
// ─────────────────────────────────────────────────────────────

// Public config — merged for both systems
app.get('/api/config', (_req, res) => {
  res.json({
    businessName  : CONFIG.BUSINESS_NAME,
    businessEmoji : CONFIG.BUSINESS_EMOJI,
    businessPhone : CONFIG.BUSINESS_PHONE,
    autoCancelMin : CONFIG.AUTO_CANCEL_MIN,
    staffPin      : CONFIG.STAFF_PIN,
    publicUrl     : CONFIG.PUBLIC_URL,
  });
});

// ═════════════════════════════════════════════════════════════
//  WAITING SYSTEM APIs — /api/queue/*, /api/stream, /api/waiting/*
// ═════════════════════════════════════════════════════════════

// SSE real-time stream with heartbeat (waiting data only)
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ queue, history: waitHistory })}\n\n`);
  sseClients.push(res);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); } }, 15000);
  req.on('close', () => { clearInterval(hb); sseClients = sseClients.filter(c => c !== res); });
});

app.get('/api/queue', (_req, res) => res.json(queue));

// ── Guest: join the waiting list ──
app.post('/api/queue/join', async (req, res) => {
  try {
    const result = await withQueueLock(async () => {
      const { name, phone, partySize, email } = req.body;
      if (!name?.trim())
        return { status: 400, body: { error: 'Please enter your name.' } };
      if (!phone?.trim() && !email?.trim())
        return { status: 400, body: { error: 'Please enter a phone number or email.' } };

      // Validate name length (prevent screen-breaking long names)
      const cleanName = name.trim().slice(0, 50);

      // Validate email format if provided
      const cleanEmail = (email || '').trim();
      if (cleanEmail) {
        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRe.test(cleanEmail)) {
          return { status: 400, body: { error: 'Please enter a valid email address. / 이메일 형식이 올바르지 않습니다.' } };
        }
        if (cleanEmail.length > 100) {
          return { status: 400, body: { error: 'Email is too long.' } };
        }
      }

      const cleanPhone = (phone || '').trim().replace(/-/g, '');
      const size = Math.max(1, Math.min(20, parseInt(partySize) || 2));

      // Foreign guests must provide email — international SMS is unreliable, we send via email only.
      // Korean numbers (+82/010/011 etc.) are exempt — they receive SMS through Aligo.
      if (cleanPhone) {
        const isKorean = /^(\+?82|0[1-7])/.test(cleanPhone);
        if (!isKorean && !cleanEmail) {
          return { status: 400, body: { error: 'Please provide your email — we\'ll send your table notifications there. / 한국 번호가 아닌 경우 이메일을 부탁드립니다. 자리 안내를 이메일로 보내드립니다.' } };
        }
      }

      // Duplicate check: phone
      if (cleanPhone) {
        const existing = queue.find(q => q.phone && q.phone.replace(/-/g, '') === cleanPhone);
        if (existing)
          return { status: 409, body: { error: 'This phone number is already in the waiting list. / 이미 등록된 전화번호입니다.', existing } };
      }
      // Duplicate check: email (NEW — prevents same email registering twice)
      if (cleanEmail) {
        const existing = queue.find(q => q.email && q.email.toLowerCase() === cleanEmail.toLowerCase());
        if (existing)
          return { status: 409, body: { error: 'This email is already in the waiting list. / 이미 등록된 이메일입니다.', existing } };
      }

      const entry = {
        id: uid(), number: nextNumber(),
        name: cleanName, phone: (phone || '').trim(),
        email: cleanEmail || null,
        partySize: size,
        joinedAt: Date.now(), status: 'waiting',
      };
      queue.push(entry);
      saveQueue();  // 🔒 Persist to disk immediately (prevents data loss on crash/restart)
      broadcastQueue();

      const waitingList = queue.filter(q => q.status === 'waiting');
      const myPos = waitingList.findIndex(q => q.id === entry.id) + 1;
      sendWaitingMessage(entry, 'join', { myPos, total: waitingList.length }).catch(err => {
        console.error('[JOIN] sendWaitingMessage failed:', err.message);
      });

      return { status: 200, body: entry };
    });
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('JOIN error:', e);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── Migration: bulk import from old waiting app (no SMS sent) ──
// PIN-protected. Imports preserve original timestamps so wait time displays correctly.
app.post('/api/queue/migrate', async (req, res) => {
  try {
    if (req.body?.pin !== CONFIG.STAFF_PIN) return res.status(401).json({ error: 'Bad PIN' });
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!entries.length) return res.status(400).json({ error: 'No entries' });
    const result = await withQueueLock(async () => {
      let imported = 0, skipped = 0;
      for (const e of entries) {
        if (!e.name) { skipped++; continue; }
        // Skip duplicates by phone or email
        const dupPhone = e.phone && queue.find(q => q.phone && q.phone.replace(/[^0-9]/g, '') === String(e.phone).replace(/[^0-9]/g, ''));
        const dupEmail = e.email && queue.find(q => q.email && q.email.toLowerCase() === e.email.toLowerCase());
        if (dupPhone || dupEmail) { skipped++; continue; }
        queue.push({
          id: uid(), number: nextNumber(),
          name: String(e.name).trim(),
          phone: e.phone ? String(e.phone).trim() : '',
          email: e.email ? String(e.email).trim() : null,
          partySize: parseInt(e.partySize) || 2,
          joinedAt: e.joinedAt || Date.now(),
          status: 'waiting',
        });
        imported++;
      }
      saveQueue();
      broadcastQueue();
      return { imported, skipped, total: queue.length };
    });
    res.json(result);
  } catch (e) {
    console.error('MIGRATE error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Staff: notify guest (table ready) ──
app.post('/api/queue/call/:id', async (req, res) => {
  try {
    const result = await withQueueLock(async () => {
      const entry = queue.find(q => q.id === req.params.id);
      if (!entry) return { status: 404, body: { error: 'Not found.' } };
      if (entry.status === 'called') return { status: 200, body: { ok: true, note: 'Already notified' } };

      entry.status   = 'called';
      entry.calledAt = Date.now();
      if (req.body?.seat) entry.assignedSeat = req.body.seat;
      broadcastQueue();
      sendWaitingMessage(entry, 'call').catch(console.error);
      startCancelTimer(entry.id);
      return { status: 200, body: { ok: true } };
    });
    res.status(result.status).json(result.body);
  } catch (e) { console.error('CALL error:', e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Staff: update seat assignment on a waiting entry ──
app.post('/api/queue/seat/:id', async (req, res) => {
  try {
    await withQueueLock(async () => {
      const entry = queue.find(q => q.id === req.params.id);
      if (!entry) return;
      if (req.body?.seat !== undefined) { entry.assignedSeat = req.body.seat; broadcastQueue(); }
    });
    res.json({ ok: true });
  } catch (e) { console.error('SEAT UPDATE error:', e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Staff: swap seats between two waiting entries ──
app.post('/api/queue/swap', async (req, res) => {
  try {
    await withQueueLock(async () => {
      const { id1, id2 } = req.body;
      const e1 = queue.find(q => q.id === id1);
      const e2 = queue.find(q => q.id === id2);
      if (e1 && e2) {
        const tmp = e1.assignedSeat;
        e1.assignedSeat = e2.assignedSeat;
        e2.assignedSeat = tmp;
        broadcastQueue();
      }
    });
    res.json({ ok: true });
  } catch (e) { console.error('SWAP error:', e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Guest: can't come (cancel immediately) ──
app.post('/api/queue/decline/:id', async (req, res) => {
  try {
    await withQueueLock(async () => {
      const entry = queue.find(q => q.id === req.params.id);
      if (!entry) return;
      if (cancelTimers[entry.id]) { clearTimeout(cancelTimers[entry.id]); delete cancelTimers[entry.id]; }
      console.log(`❌ Guest declined: ${entry.name} (#${entry.number})`);
      moveToWaitHistory(entry, 'declined');
      queue = queue.filter(q => q.id !== entry.id);
      broadcastQueue();
    });
    res.json({ ok: true });
  } catch (e) { console.error('DECLINE error:', e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Staff: guest checked in (seated) ──
app.post('/api/queue/done/:id', async (req, res) => {
  try {
    await withQueueLock(async () => {
      if (cancelTimers[req.params.id]) { clearTimeout(cancelTimers[req.params.id]); delete cancelTimers[req.params.id]; }
      const entry = queue.find(q => q.id === req.params.id);
      if (entry) moveToWaitHistory(entry, 'checked_in');
      queue = queue.filter(q => q.id !== req.params.id);
      broadcastQueue();
    });
    res.json({ ok: true });
  } catch (e) { console.error('DONE error:', e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Staff: undo notification (back to waiting) ──
app.post('/api/queue/undo/:id', async (req, res) => {
  try {
    await withQueueLock(async () => {
      if (cancelTimers[req.params.id]) { clearTimeout(cancelTimers[req.params.id]); delete cancelTimers[req.params.id]; }
      const entry = queue.find(q => q.id === req.params.id);
      if (entry) { entry.status = 'waiting'; delete entry.calledAt; }
      broadcastQueue();
    });
    res.json({ ok: true });
  } catch (e) { console.error('UNDO error:', e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Staff/Guest: remove from queue ──
app.delete('/api/queue/:id', async (req, res) => {
  try {
    await withQueueLock(async () => {
      if (cancelTimers[req.params.id]) { clearTimeout(cancelTimers[req.params.id]); delete cancelTimers[req.params.id]; }
      const entry = queue.find(q => q.id === req.params.id);
      if (entry) moveToWaitHistory(entry, 'cancelled');
      queue = queue.filter(q => q.id !== req.params.id);
      broadcastQueue();
    });
    res.json({ ok: true });
  } catch (e) { console.error('DELETE error:', e); res.status(500).json({ error: 'Server error.' }); }
});

// ── External cancel: match by name + phone (used by FWD from waiting app) ──
// Used when guest cancels on the old waiting app — sync the cancellation here too.
app.post('/api/queue/external-cancel', async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const cleanPhone = (phone || '').replace(/[^0-9+]/g, '');
    let cancelled = 0;
    await withQueueLock(async () => {
      const matches = queue.filter(q => {
        if (q.name !== name) return false;
        if (!cleanPhone) return true; // name-only match if no phone
        const qPhone = (q.phone || '').replace(/[^0-9+]/g, '');
        return qPhone === cleanPhone || qPhone.endsWith(cleanPhone.slice(-8)) || cleanPhone.endsWith(qPhone.slice(-8));
      });
      for (const entry of matches) {
        if (cancelTimers[entry.id]) { clearTimeout(cancelTimers[entry.id]); delete cancelTimers[entry.id]; }
        moveToWaitHistory(entry, 'cancelled');
        cancelled++;
      }
      queue = queue.filter(q => !matches.includes(q));
      if (cancelled > 0) broadcastQueue();
    });
    console.log(`[EXT-CANCEL] ${name} (${phone || 'no phone'}) → ${cancelled} matched`);
    res.json({ ok: true, cancelled });
  } catch (e) { console.error('EXT-CANCEL error:', e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Waiting history & close-out summary (namespaced to avoid reserve collision) ──
app.get('/api/waiting/history', (_req, res) => res.json(waitHistory));

app.get('/api/waiting/close', (_req, res) => {
  const total = waitHistory.length + queue.length;
  const checkedIn = waitHistory.filter(h => h.outcome === 'checked_in');
  const cancelled = waitHistory.filter(h => h.outcome === 'cancelled' || h.outcome === 'declined');
  const autoCancelled = waitHistory.filter(h => h.outcome === 'auto_cancelled');
  const stillWaiting  = queue.filter(q => q.status === 'waiting').length;
  const stillNotified = queue.filter(q => q.status === 'called').length;
  res.json({
    total,
    checkedIn: checkedIn.length,
    cancelled: cancelled.length,
    autoCancelled: autoCancelled.length,
    stillWaiting, stillNotified,
    checkedInList: checkedIn,
  });
});

// ═════════════════════════════════════════════════════════════
//  RESERVATION SYSTEM APIs
// ═════════════════════════════════════════════════════════════

// Events (blocked dates)
app.get('/api/events', (_req, res) => res.json(events));
app.post('/api/events/:date', (req, res) => {
  const { date } = req.params;
  const { pin, label } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  if (label) events[date] = label;
  else delete events[date];
  saveEvents();
  res.json({ ok: true, events });
});

// Availability for a single date
app.get('/api/availability/:date', (req, res) => {
  const { date } = req.params;
  if (events[date]) return res.json({ blocked: true, event: events[date] });
  const slots = getSlots(date);

  const result = {};
  const kstNow   = new Date(Date.now() + 9 * 3600000);
  const isToday  = date === kstToday();
  const nowHour  = kstNow.getHours() + kstNow.getMinutes() / 60;

  slots.forEach(time => {
    // CRITICAL FIX: calculate occupancy per time slot (not whole day)
    // Past bug: same `occ` for all times caused false "fully booked" reports.
    const occ = getOccupiedFor(date, time);
    const barFree    = CONFIG.SEATS.bar.filter(s => !occ.includes(s)).length;
    const tablesFree = CONFIG.SEATS.tables.filter(s => !occ.includes(s)).length;
    const highFree   = CONFIG.SEATS.highTables.filter(s => !occ.includes(s)).length;
    const roomFree   = !occ.includes('ROOM') ? 1 : 0;

    const isLate = time === CONFIG.LATE_SLOT && !isWeekend(date);
    let eBar = barFree, eTbl = tablesFree;
    if (isLate) {
      const ex = getResFor(date, time);
      const ub = ex.filter(r => r.zone==='bar').reduce((s,r) => s + r.partySize, 0);
      const ut = ex.filter(r => r.zone==='table' || r.zone==='highTable').length;
      eBar = Math.max(0, CONFIG.LATE_BAR_MAX - ub);
      eTbl = Math.max(0, CONFIG.LATE_TABLE_MAX - ut);
    }
    const closed = isToday && nowHour >= 17;
    const availPax = [];
    for (let ps = 1; ps <= 10; ps++) {
      if (autoAssign(date, time, ps, null)) availPax.push(ps);
    }
    result[time] = { bar:eBar, tables:eTbl, highTables:highFree, room:roomFree, isLate, closed, occupiedSeats:occ, availPax };
  });
  res.json(result);
});

// Guest reservation creation
app.post('/api/reserve', async (req, res) => {
  const { name, phone, instagram, email, partySize, date, time, specialRequest } = req.body;
  if (!name || !partySize || !date || !time) return res.status(400).json({ error: 'Required fields missing.' });
  if (partySize < 1 || partySize > 10) return res.status(400).json({ error: 'Party size 1-10.' });
  if (events[date]) return res.status(400).json({ error: '이 날짜는 예약을 받지 않습니다 (EVENT). / This date is not available (event).' });
  const slots = getSlots(date);
  if (!slots.includes(time)) return res.status(400).json({ error: 'Invalid time.' });

  if (date === kstToday()) {
    const kstNow = new Date(Date.now() + 9 * 3600000);
    const nowHour = kstNow.getHours() + kstNow.getMinutes() / 60;
    if (nowHour >= 17) return res.status(400).json({ error: "Today's reservations are closed. Walk-ins welcome after 7PM!" });
  }

  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';

  if (phone) {
    const cleanPhone = phone.replace(/[^0-9+]/g, '');
    const dup = reservations.find(r => r.date === date && r.phone && r.phone.replace(/[^0-9+]/g, '') === cleanPhone && r.status !== 'cancelled');
    if (dup) return res.status(400).json({ error: '이미 해당 날짜에 예약이 있습니다. 변경은 전화로 문의해주세요. / You already have a reservation on this date.' });
  }
  if (email) {
    const dup = reservations.find(r => r.date === date && r.email && r.email.toLowerCase() === email.toLowerCase() && r.status !== 'cancelled');
    if (dup) return res.status(400).json({ error: '이미 해당 날짜에 예약이 있습니다. / You already have a reservation on this date.' });
  }
  if (phone) {
    const activeCount = reservations.filter(r => r.phone && r.phone.replace(/[^0-9+]/g, '') === phone.replace(/[^0-9+]/g, '') && r.status === 'confirmed').length;
    if (activeCount >= 3) return res.status(400).json({ error: '예약 가능 횟수를 초과했습니다. / Maximum reservation limit reached.' });
  }
  const today = kstToday();
  const ipCount = reservations.filter(r => {
    if (r._ip !== ip || !r.createdAt) return false;
    const createdKstDate = new Date(new Date(r.createdAt).getTime() + 9*3600000).toISOString().slice(0,10);
    return createdKstDate === today;
  }).length;
  if (ipCount >= 1) return res.status(429).json({ error: '오늘 이미 예약하셨습니다. 추가 예약은 전화로 문의해주세요. / You already made a reservation today.' });

  try {
    await withResLock(async () => {
      // ── Late-night (23:00) hard cap: max 2 teams per day ──
      // Owner policy: 11PM slot limited to 2 teams to ensure proper closing time.
      if (time === CONFIG.LATE_SLOT) {
        const lateCount = reservations.filter(r =>
          r.date === date &&
          r.time === CONFIG.LATE_SLOT &&
          r.status !== 'cancelled' &&
          r.status !== 'noshow'
        ).length;
        if (lateCount >= 2) {
          throw new Error('23:00(11PM) 예약은 하루 2팀까지만 가능합니다. 다른 시간을 선택해주세요. / Late night (11PM) reservations are limited to 2 teams per day. Please select another time.');
        }
      }
      const a = autoAssign(date, time, partySize, null);
      if (!a) {
        if (partySize <= 2) throw new Error('바와 하이테이블이 모두 예약되었습니다. / Bar and high table seats are fully booked for this date.');
        if (partySize <= 5) throw new Error('테이블 좌석이 모두 예약되었습니다. / Table seats are fully booked for this date.');
        if (partySize >= 6) throw new Error('프라이빗 룸이 예약되었습니다. 6명 이상은 전화(+82-10-6817-0406) 또는 방문해주세요. / The private room is fully booked. For groups of 6+, please call us at +82-10-6817-0406 or walk in.');
        throw new Error('No seats available.');
      }
      const confirmCode = 'PC' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2,4);
      const r = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
        confirmCode,
        name, phone: phone || '', instagram: instagram || '', email: email || '',
        partySize, date, time, preference: 'auto',
        zone: a.zone, seats: a.seats, status: 'confirmed', source: 'online',
        notes: specialRequest || '', createdAt: new Date().toISOString(),
        _ip: ip, reminderD1: false, reminderD0: false, modLog: [],
      };
      reservations.push(r); saveRes();
      sendReserveConfirmation(r);
      logReservationCreation(r);
      console.log('🎫 Reservation: ' + name + ' / ' + date + ' ' + time + ' / ' + confirmCode);
      res.json({ ok: true, reservation: r });
    });
  } catch(e) { res.status(409).json({ error: e.message }); }
});

// Staff names
app.get('/api/staff-names', (_req, res) => res.json(staffNames));
app.post('/api/staff-names', (req, res) => {
  const { pin, name } = req.body;
  if (pin !== CONFIG.ADMIN_PIN) return res.status(403).json({ error: 'Admin PIN required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const n = name.trim();
  if (staffNames.includes(n)) return res.status(400).json({ error: 'Already exists' });
  staffNames.push(n); saveStaff();
  res.json({ ok: true, staffNames });
});
app.delete('/api/staff-names/:name', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== CONFIG.ADMIN_PIN) return res.status(403).json({ error: 'Admin PIN required' });
  const n = decodeURIComponent(req.params.name);
  staffNames = staffNames.filter(s => s !== n); saveStaff();
  res.json({ ok: true, staffNames });
});

// Month calendar data
app.get('/api/month/:year/:month', (req, res) => {
  const prefix = `${req.params.year}-${String(req.params.month).padStart(2,'0')}`;
  const counts = {};
  const fullDates = [];
  reservations.forEach(r => { if (r.date.startsWith(prefix) && r.status!=='cancelled' && r.status!=='noshow' && r.status!=='seated') counts[r.date] = (counts[r.date]||0) + 1; });
  const datesWithRes = new Set(Object.keys(counts));
  reservations.forEach(r => { if (r.date.startsWith(prefix)) datesWithRes.add(r.date); });
  datesWithRes.forEach(date => {
    const canBook = [1,2,3,4,5,6].some(pax => autoAssign(date, '19:00', pax, null) !== null);
    if (!canBook) fullDates.push(date);
  });
  res.json({ counts, fullDates });
});

// Staff-side reservation creation (manual entry)
app.post('/api/staff/reserve', (req, res) => {
  const { pin, name, phone, instagram, email, partySize, date, time, zone, seats, source, notes, staffName } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  const r = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name, phone: phone || '', instagram: instagram || '', email: email || '',
    partySize: partySize || 1, date, time, preference: '',
    zone: zone || 'bar', seats: seats || [], status: 'confirmed',
    source: source || 'staff', notes: notes || '',
    confirmCode: 'PC' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2,4),
    createdAt: new Date().toISOString(), reminderD1: false, reminderD0: false,
    modLog: [{ action:'created', by: staffName||'Staff', at: new Date().toISOString() }],
  };
  reservations.push(r); saveRes();
  logReservationCreation(r);
  res.json({ ok: true, reservation: r });
});

// Get reservations for a date (enriched with returning info)
app.get('/api/reservations/:date', (req, res) => {
  const list = reservations.filter(r => r.date===req.params.date && r.status!=='cancelled');
  const enriched = list.map(r => {
    const rv = checkReturning(r.name, r.phone, r.email, r.instagram);
    return { ...r, _returning: rv.returning, _visitCount: rv.visits || 0, _lastVisit: rv.lastVisit || '', _firstVisit: rv.firstVisit || '', _prefZone: rv.prefZone || '', _recentVisits: rv.recentVisits || [] };
  });
  res.json(enriched);
});

// Returning check, visitor list
app.post('/api/check-returning', (req, res) => {
  const { name, phone, email, instagram } = req.body;
  res.json(checkReturning(name, phone, email, instagram));
});
app.get('/api/visitors', (_req, res) => res.json(visitors));

// Backups
app.get('/api/backups', (_req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR).sort().reverse();
    const list = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
      return { file: f, count: data.length, size: fs.statSync(path.join(BACKUP_DIR, f)).size };
    });
    res.json({ ok: true, backups: list, dataDir: DATA_DIR });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/restore-backup', (req, res) => {
  const { pin, file } = req.body;
  if (pin !== CONFIG.ADMIN_PIN) return res.status(403).json({ error: 'Admin PIN required' });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, file), 'utf8'));
    fs.writeFileSync(path.join(BACKUP_DIR, 'emergency_before_restore.json'), JSON.stringify(reservations));
    reservations = data;
    saveRes();
    console.log('🔄 Restored from backup: ' + file + ' (' + data.length + ')');
    res.json({ ok: true, count: data.length });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Data health check
app.get('/api/data-health', (_req, res) => {
  res.json({
    dataDir: DATA_DIR,
    reservationsFile: fs.existsSync(DATA_FILE),
    reservationCount: reservations.length,
    activeCount: reservations.filter(r => r.status==='confirmed'||r.status==='seated').length,
    queueCount: queue.length,
    waitHistoryCount: waitHistory.length,
    backupCount: fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).length : 0,
    lastSave: fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtime : null,
  });
});

// Sheet setup
app.post('/api/sheet-setup', async (req, res) => {
  if (req.body.pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  if (!CONFIG.GOOGLE_SHEET_ID || !CONFIG.GOOGLE_CLIENT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY) {
    return res.json({ ok: false, error: 'GOOGLE_SHEET_ID not configured' });
  }
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT(CONFIG.GOOGLE_CLIENT_EMAIL, null, CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g,'\n'), ['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID, range: 'Sheet1!A1:M1', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['날짜','시간','이름','인원','전화번호','이메일','인스타','좌석타입','좌석번호','예약경로','방문유형','특이사항','기록시간']] },
    });
    try { await sheets.spreadsheets.batchUpdate({ spreadsheetId: CONFIG.GOOGLE_SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: '예약로그' } } }] } }); } catch(e) {}
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID, range: '예약로그!A1:N1', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['접수시간','확인코드','예약날짜','시간','이름','인원','전화번호','이메일','인스타','좌석타입','좌석번호','예약경로','특이사항','상태']] },
    });
    res.json({ ok: true, message: 'Sheet1 + 예약로그 headers set!' });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// New reservations received today (not yet checked by staff)
app.get('/api/new-today', (_req, res) => {
  const today = kstToday();
  // Convert each createdAt (UTC) to KST date for comparison
  const newOnes = reservations.filter(r => {
    if (!r.createdAt) return false;
    if (r.status === 'cancelled') return false;
    if (r.staffChecked) return false;
    // Convert UTC createdAt to KST date string for comparison
    const createdKstDate = new Date(new Date(r.createdAt).getTime() + 9*3600000).toISOString().slice(0,10);
    return createdKstDate === today;
  });
  const enriched = newOnes.map(r => {
    const rv = checkReturning(r.name, r.phone, r.email, r.instagram);
    return { ...r, _returning: rv.returning, _visitCount: rv.visits || 0, _lastVisit: rv.lastVisit || '', _firstVisit: rv.firstVisit || '', _prefZone: rv.prefZone || '', _recentVisits: rv.recentVisits || [] };
  });
  res.json(enriched);
});

// PATCH reservation (edit any field)
app.patch('/api/reservations/:id', (req, res) => {
  const r = reservations.find(x => x.id===req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const ch = [];
  if (req.body.status && req.body.status!==r.status) { ch.push('status:'+r.status+'→'+req.body.status); r.status=req.body.status; if(r.status==='seated') recordVisit(r); }
  if (req.body.notes!==undefined && req.body.notes!==r.notes) { ch.push('notes updated'); r.notes=req.body.notes; }
  if (req.body.source && req.body.source!==r.source) { ch.push('source:'+r.source+'→'+req.body.source); r.source=req.body.source; }
  if (req.body.time   && req.body.time!==r.time)     { ch.push('time:'+r.time+'→'+req.body.time); r.time=req.body.time; }
  if (req.body.partySize && req.body.partySize!==r.partySize) { ch.push('partySize:'+r.partySize+'→'+req.body.partySize); r.partySize=req.body.partySize; }
  if (req.body.name && req.body.name!==r.name)       { ch.push('name:'+r.name+'→'+req.body.name); r.name=req.body.name; }
  if (req.body.phone!==undefined && req.body.phone!==r.phone) { ch.push('phone updated'); r.phone=req.body.phone; }
  if (req.body.email!==undefined && req.body.email!==r.email) { ch.push('email updated'); r.email=req.body.email; }
  if (req.body.instagram!==undefined && req.body.instagram!==r.instagram) { ch.push('instagram updated'); r.instagram=req.body.instagram; }
  if (req.body.seats) {
    const old = r.seats ? r.seats.join(',') : 'none';
    r.seats = req.body.seats;
    if (req.body.zone) r.zone = req.body.zone;
    ch.push('seat:'+old+'→'+req.body.seats.join(','));
    if (r.status === 'needs_assignment') r.status = 'confirmed';
  }
  if (req.body.notified !== undefined) { r.notified = req.body.notified; ch.push('notified: '+req.body.notified); }
  if (req.body.notifiedSeats !== undefined) { r.notifiedSeats = req.body.notifiedSeats; ch.push('notified seats: '+req.body.notifiedSeats.join(',')); }
  if (req.body.untilTime !== undefined) { r.untilTime = req.body.untilTime; ch.push('until: '+(req.body.untilTime || 'cleared')); }
  if (req.body.staffChecked !== undefined) { r.staffChecked = req.body.staffChecked; }
  if (ch.length) { if (!r.modLog) r.modLog = []; r.modLog.push({ action: ch.join(', '), by: req.body.staffName || 'Staff', at: new Date().toISOString() }); }
  saveRes();
  res.json({ ok: true, reservation: r });
});

// Swap seats between two reservations
app.post('/api/swap-seats', (req, res) => {
  const { id1, id2, staffName } = req.body;
  const r1 = reservations.find(x => x.id===id1);
  const r2 = reservations.find(x => x.id===id2);
  if (!r1 || !r2) return res.status(404).json({ error: 'Reservation not found' });
  const s1 = r1.seats, z1 = r1.zone;
  r1.seats = r2.seats; r1.zone = r2.zone;
  r2.seats = s1; r2.zone = z1;
  const ts = new Date().toISOString();
  if (!r1.modLog) r1.modLog = []; if (!r2.modLog) r2.modLog = [];
  r1.modLog.push({ action: 'swapped with '+r2.name+': '+s1.join(',')+'→'+r1.seats.join(','), by: staffName||'Staff', at: ts });
  r2.modLog.push({ action: 'swapped with '+r1.name+': '+r2.seats.join(',')+'→'+s1.join(','), by: staffName||'Staff', at: ts });
  saveRes();
  res.json({ ok: true });
});

// Walk-in (create as a reservation with source:walkin, status:seated)
app.post('/api/walkin', (req, res) => {
  const { pin, name, partySize, seats, zone, untilTime, date, staffName } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  const r = {
    id: 'wi_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    name: name || 'Walk-in', phone: '', instagram: '', email: '',
    partySize: partySize || 1, date: date || kstToday(),
    time: 'walkin', preference: 'manual',
    zone: zone || 'bar', seats: seats || [],
    status: 'seated', source: 'walkin',
    untilTime: untilTime || '', notified: false,
    notes: untilTime ? '⏰ '+untilTime+'까지 이용' : 'Walk-in',
    createdAt: new Date().toISOString(), reminderD1: false, reminderD0: false,
    modLog: [{ action: 'walk-in seated', by: staffName||'Staff', at: new Date().toISOString() }],
  };
  reservations.push(r); saveRes();
  res.json({ ok: true, reservation: r });
});

// Delete reservation
app.delete('/api/reservations/:id', (req, res) => {
  reservations = reservations.filter(r => r.id!==req.params.id);
  saveRes();
  res.json({ ok: true });
});

// History view for reservations (distinct from /api/waiting/history)
app.get('/api/history', (_req, res) => {
  const hist = reservations.filter(r => r.status==='seated' || r.status==='noshow' || r.status==='completed')
    .sort((a,b) => b.date < a.date ? -1 : 1);
  res.json(hist);
});

// Verify reservation by code (used by guest who lost confirmation)
app.get('/api/verify/:code', (req, res) => {
  const r = reservations.find(x => x.confirmCode === req.params.code);
  if (r) res.json({ ok: true, reservation: { name: r.name, date: r.date, time: r.time, partySize: r.partySize, status: r.status } });
  else res.json({ ok: false, error: 'Reservation not found' });
});

// No-show stats
app.get('/api/stats/noshow', (_req, res) => {
  const t = reservations.length, n = reservations.filter(r=>r.status==='noshow').length;
  res.json({ total: t, noshows: n, rate: (t ? Math.round(n/t*100) : 0) + '%' });
});

// Debug: date diagnostic
app.get('/api/debug/:date', (req, res) => {
  const date = req.params.date;
  const occ = getOccupiedForDate(date);
  const allRes = reservations.filter(r => r.date === date);
  const activeRes = allRes.filter(r => r.status !== 'cancelled' && r.status !== 'noshow');
  const slots = getSlots(date);
  const tests = {};
  [1,2,3,4,5,6].forEach(ps => { tests[ps+'pax'] = autoAssign(date, '19:00', ps, null); });
  res.json({
    date, isWeekend: isWeekend(date), slots,
    totalReservations: allRes.length, activeReservations: activeRes.length,
    occupiedSeats: occ,
    events: events[date] || null,
    autoAssignTests: tests,
    reservationDetails: activeRes.map(r => ({ id:r.id, name:r.name, time:r.time, partySize:r.partySize, seats:r.seats, status:r.status, source:r.source })),
  });
});

// ═════════════════════════════════════════════════════════════
//  GOOGLE CALENDAR SYNC
// ═════════════════════════════════════════════════════════════
function looksLikeReservation(text) {
  if (!text) return false;
  const hasTime  = /\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*(pm|am|PM|AM)|\d{1,2}\s*시|오후/.test(text);
  const hasPax   = /\d+\s*(pax|명|people|persons|guests|PAX)|Number\s*of\s*People/i.test(text);
  const hasPhone = /01[0-9][\-\s]?\d{3,4}[\-\s]?\d{4}|\+\d{10,}|Contact\s*:/i.test(text);
  const hasInsta = /@\w|instagram|ig\s*:/i.test(text);
  const hasName  = /^Name\s*:/im.test(text);
  return hasTime || hasPax || hasPhone || hasInsta || hasName;
}

function parseGcalEntry(text) {
  const result = { name:'Guest', time:null, partySize:2, phone:'', instagram:'', staffName:'', raw:text };
  if (!text) return result;
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
    if (!ampm && !text.includes('오후') && h >= 1 && h <= 12) h += 12;
    if (h >= 1 && h <= 6) h += 12;
    if (h >= 7 && h <= 12) h += 12;
    if (h > 24) h = h - 12;
    result.time = String(h).padStart(2, '0') + ':00';
    result.exactTime = fullTimeMatch[0];
  }
  if (!result.phone) {
    const phoneInText = text.match(/\b(01[0-9][\-\s]?\d{3,4}[\-\s]?\d{4})\b/) || text.match(/(\+\d{10,15})/) || text.match(/Contact\s*:\s*([\+\d\s\-]{10,})/i);
    if (phoneInText) result.phone = phoneInText[1].replace(/[\s\-]/g, '');
  }
  const nameInText = text.match(/Name\s*:\s*([A-Za-z\u3131-\uD79D]+(?:\s+[A-Za-z\u3131-\uD79D]+)*)/i);
  if (nameInText) result.name = nameInText[1].trim();

  const parts = text.split(/[\/·,]|\s{2,}/).map(s => s.trim()).filter(Boolean);
  const unmatched = [];
  for (const part of parts) {
    const p = part.trim(); if (!p) continue;
    if (/^@\w/.test(p)) { result.instagram = p; continue; }
    const igMatch = p.match(/(?:instagram|ig|insta)\s*[:\s]\s*@?(\w+)/i);
    if (igMatch) { result.instagram = '@' + igMatch[1]; continue; }
    if (/^\d{1,2}\s*:\s*\d{2}/.test(p)) continue;
    if (/^\d{1,2}\s*(pm|am|PM|AM)$/.test(p)) continue;
    if (/^\d{1,2}\s*시$/.test(p)) continue;
    if (/^오후/.test(p)) continue;
    const paxMatch = p.match(/(\d{1,2})\s*(pax|명|people|persons|guests|PAX)/i);
    if (paxMatch) { result.partySize = parseInt(paxMatch[1]); continue; }
    const nopMatch = p.match(/Number\s*of\s*People\s*:\s*(\d+)/i);
    if (nopMatch) { result.partySize = parseInt(nopMatch[1]); continue; }
    if (/^\d{1,2}$/.test(p) && parseInt(p) >= 1 && parseInt(p) <= 10 && !result._gotPax) { result.partySize = parseInt(p); result._gotPax = true; continue; }
    const paxEmbed = p.match(/^(\d{1,2})명$/);
    if (paxEmbed) { result.partySize = parseInt(paxEmbed[1]); continue; }
    const phoneClean = p.replace(/[\s\-().]/g, '');
    if (/^[\+]?\d{8,15}$/.test(phoneClean)) { result.phone = phoneClean; continue; }
    const contactMatch = p.match(/Contact\s*:\s*([\+\d\s\-]+)/i);
    if (contactMatch) { result.phone = contactMatch[1].replace(/[\s\-]/g, ''); continue; }
    if (/^(Name|Date|Time|Contact|Number|Hi+!*|전화예약|신규|가게전화|바좌석|요정|요청)\s*:?$/i.test(p)) continue;
    const nameMatch = p.match(/^Name\s*:\s*(.+)/i);
    if (nameMatch && result.name === 'Guest') { result.name = nameMatch[1].trim(); continue; }
    unmatched.push(p);
  }
  if (unmatched.length >= 1 && result.name === 'Guest') result.name = unmatched[0];
  if (result.name === 'Guest' || result.name === 'April 10th') {
    const words = text.split(/[\s\/,·]+/);
    for (const w of words) {
      if (!w) continue;
      if (/^\d/.test(w)) continue;
      if (/^[@+]/.test(w)) continue;
      if (/^(Name|Date|Time|Contact|Number|Hi+|Instagram|of|People|Friday|April|and|the|th|PM|AM|pax|Pax|PAX)\b/i.test(w)) continue;
      if (/^(신규|가게전화|전화예약|바좌석|요정|요청|오후|오전)\b/.test(w)) continue;
      if (w.length < 2) continue;
      result.name = w.replace(/님$/, ''); break;
    }
  }
  if (unmatched.length >= 2) {
    const last = unmatched[unmatched.length - 1];
    if (!/^(bar|table|room|바|테이블|룸|counter|private|신규|가게전화|전화예약)\s*$/i.test(last)) result.staffName = last;
  }
  delete result._gotPax;
  return result;
}

function snapToSlot(time, date) {
  const slots = isWeekendForSlots(date) ? CONFIG.WEEKEND_SLOTS : CONFIG.WEEKDAY_SLOTS;
  if (slots.includes(time)) return time;
  const h = parseInt(time.split(':')[0]);
  let best = slots[0], bestDiff = 999;
  slots.forEach(s => {
    const sh = parseInt(s.split(':')[0]);
    const diff = Math.abs(sh - h);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  });
  return best;
}

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
    const auth = new google.auth.JWT(CONFIG.GOOGLE_CLIENT_EMAIL, null, CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g,'\n'), ['https://www.googleapis.com/auth/calendar.readonly']);
    const cal = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const twoMonths = new Date(now.getTime() + 62 * 86400000);
    const r = await cal.events.list({
      calendarId: CONFIG.GOOGLE_CALENDAR_ID,
      timeMin: todayStartUTC().toISOString(),
      timeMax: twoMonths.toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 500,
    });
    const gcalEvents = r.data.items || [];
    let added = 0;
    const warnings = [];
    gcalEvents.forEach(ev => {
      if (reservations.find(x => x.gcalId === ev.id)) return;
      if (ev.status === 'cancelled') return;
      const title = ev.summary || '';
      const desc  = ev.description || '';
      if (!title.trim() && !desc.trim()) return;
      const fullText = title + (desc ? ' / ' + desc : '');
      if (!looksLikeReservation(fullText)) { console.log('📅 [GCAL] Skipped: ' + title); return; }
      let date, fallbackTime;
      if (ev.start && ev.start.dateTime) { const start = new Date(ev.start.dateTime); date = start.toISOString().slice(0,10); fallbackTime = String(start.getHours()).padStart(2,'0')+':00'; }
      else if (ev.start && ev.start.date) { date = ev.start.date; fallbackTime = '19:00'; }
      else { date = kstToday(); fallbackTime = '19:00'; warnings.push('⚠️ 날짜없음: '+title+' → 오늘로'); }
      const parsed = parseGcalEntry(fullText);
      let rawTime = parsed.time || fallbackTime;
      const time = snapToSlot(rawTime, date);
      const pref = detectPreference(fullText, parsed.partySize);
      const a = autoAssign(date, time, parsed.partySize, pref);
      let notes = '📅 ' + title;
      if (parsed.exactTime) notes += '\n⏰ 정확한 시간: ' + parsed.exactTime;
      if (parsed.staffName) notes += '\n👤 담당: ' + parsed.staffName;
      if (desc) notes += '\n📄 ' + desc;
      let status = 'confirmed';
      if (!a) { status = 'needs_assignment'; warnings.push('🚨 좌석부족: '+parsed.name+' / '+date+' '+time+' / '+parsed.partySize+'명'); notes += '\n\n🚨 자동 좌석 배정 실패 — 수동 배정 필요!'; }
      if (parsed.name === 'Guest' && title.trim()) parsed.name = title.split(/[\/·,]/)[0].trim() || 'Guest';
      reservations.push({
        id: 'gc_'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
        gcalId: ev.id,
        name: parsed.name, phone: parsed.phone, instagram: parsed.instagram, email: '',
        partySize: parsed.partySize, date, time, preference: pref || 'auto',
        zone: a ? a.zone : 'unassigned', seats: a ? a.seats : [],
        status, source: 'google_calendar', notes,
        confirmCode: 'PC' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2,4),
        createdAt: new Date().toISOString(), reminderD1: false, reminderD0: false,
        modLog: [{ action: 'Google Calendar import'+(a?'':' (⚠️미배정)'), by: parsed.staffName || 'System', at: new Date().toISOString() }],
      });
      logReservationCreation(reservations[reservations.length-1]);
      added++;
      console.log('📅 '+(a?'✅':'⚠️')+' '+parsed.name+' / '+date+' '+time+' / '+parsed.partySize+'pax');
    });
    if (added > 0) saveRes();
    console.log('📅 [GCAL] +'+added+' / warnings:'+warnings.length+' / total events:'+gcalEvents.length);
    return { added, warnings, total: gcalEvents.length };
  } catch (e) {
    console.error('📅 [GCAL] Error:', e.message);
    return { added: 0, warnings: ['❌ '+e.message], total: 0 };
  }
}

// ── Gcal diagnostic APIs ──
app.post('/api/gcal-sync', async (req, res) => {
  const { pin } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  if (req.body.force) {
    const before = reservations.length;
    reservations = reservations.filter(r => r.source !== 'google_calendar');
    saveRes();
    console.log('📅 [GCAL] Force cleared '+(before-reservations.length)+' old gcal imports');
  }
  const result = await syncGoogleCalendar();
  res.json({ ok: true, added: result.added, warnings: result.warnings, total: result.total, reservationCount: reservations.length });
});

app.post('/api/gcal-test', async (req, res) => {
  const { pin } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  const diag = {
    hasEmail: !!CONFIG.GOOGLE_CLIENT_EMAIL, hasKey: !!CONFIG.GOOGLE_PRIVATE_KEY,
    keyLength: (CONFIG.GOOGLE_PRIVATE_KEY||'').length,
    hasCalId: !!CONFIG.GOOGLE_CALENDAR_ID,
    calId: CONFIG.GOOGLE_CALENDAR_ID || '(empty)', email: CONFIG.GOOGLE_CLIENT_EMAIL || '(empty)',
  };
  if (!diag.hasEmail || !diag.hasKey || !diag.hasCalId) return res.json({ ok: false, error: 'Missing env vars', diag });
  try {
    const { google } = require('googleapis');
    const key = CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g,'\n');
    diag.keyStart = key.substring(0,30);
    diag.keyHasNewlines = key.includes('\n');
    const auth = new google.auth.JWT(CONFIG.GOOGLE_CLIENT_EMAIL, null, key, ['https://www.googleapis.com/auth/calendar.readonly']);
    const cal = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const twoMonths = new Date(now.getTime() + 62 * 86400000);
    const result = await cal.events.list({
      calendarId: CONFIG.GOOGLE_CALENDAR_ID,
      timeMin: todayStartUTC().toISOString(), timeMax: twoMonths.toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 500,
    });
    const events2 = result.data.items || [];
    const alreadyImported = [], notImported = [];
    events2.forEach(ev => {
      if (ev.status === 'cancelled') return;
      const title = ev.summary || '(no title)';
      const fullText = title + ' ' + (ev.description || '');
      if (!looksLikeReservation(fullText)) return;
      let date = '';
      if (ev.start && ev.start.dateTime) date = new Date(ev.start.dateTime).toISOString().slice(0,10);
      else if (ev.start && ev.start.date) date = ev.start.date;
      const existing = reservations.find(r => r.gcalId === ev.id);
      const entry = { id: ev.id, title, date, imported: !!existing };
      if (existing) alreadyImported.push(entry); else notImported.push(entry);
    });
    res.json({ ok: true, totalEvents: events2.length, alreadyImported: alreadyImported.length, notImported: notImported.length, notImportedList: notImported, alreadyImportedList: alreadyImported, diag });
  } catch(e) { res.json({ ok: false, error: e.message, diag }); }
});

app.post('/api/gcal-report', async (req, res) => {
  const { pin } = req.body;
  if (pin !== CONFIG.STAFF_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  if (!CONFIG.GOOGLE_CLIENT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY || !CONFIG.GOOGLE_CALENDAR_ID) return res.json({ ok: false, error: 'Google Calendar not configured' });
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.JWT(CONFIG.GOOGLE_CLIENT_EMAIL, null, CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g,'\n'), ['https://www.googleapis.com/auth/calendar.readonly']);
    const cal = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const twoMonths = new Date(now.getTime() + 62 * 86400000);
    const r = await cal.events.list({ calendarId: CONFIG.GOOGLE_CALENDAR_ID, timeMin: todayStartUTC().toISOString(), timeMax: twoMonths.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 500 });
    const events2 = (r.data.items || []).filter(ev => ev.status !== 'cancelled' && (ev.summary||'').trim() && looksLikeReservation((ev.summary||'')+' '+(ev.description||'')));
    const report = events2.map(ev => {
      const imported = reservations.find(x => x.gcalId === ev.id);
      const title = ev.summary || '';
      let date = '';
      if (ev.start && ev.start.dateTime) date = new Date(ev.start.dateTime).toISOString().slice(0,10);
      else if (ev.start && ev.start.date) date = ev.start.date;
      const parsed = parseGcalEntry(title + (ev.description ? ' / '+ev.description : ''));
      return { gcalId: ev.id, title, date, parsed: { name: parsed.name, time: parsed.time, partySize: parsed.partySize, phone: parsed.phone, instagram: parsed.instagram, staffName: parsed.staffName }, imported: !!imported, systemId: imported ? imported.id : null, systemStatus: imported ? imported.status : null };
    });
    res.json({ ok: true, total: events2.length, imported: report.filter(r => r.imported).length, missing: report.filter(r => !r.imported).length, report });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Bulk import (paste multiple reservations)
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
    const r = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      name: parsed.name, phone: parsed.phone, instagram: parsed.instagram, email: '',
      partySize: parsed.partySize, date, time, preference: pref || 'auto',
      zone: a ? a.zone : 'unassigned', seats: a ? a.seats : [],
      status: a ? 'confirmed' : 'needs_assignment',
      source: 'bulk_import', notes: '원본: '+line+(parsed.staffName?'\n👤 담당: '+parsed.staffName:''),
      createdAt: new Date().toISOString(), reminderD1: false, reminderD0: false,
      modLog: [{ action: 'bulk import', by: req.body.staffName || 'Staff', at: new Date().toISOString() }],
    };
    reservations.push(r);
    results.push({ line, name: parsed.name, time, partySize: parsed.partySize, phone: parsed.phone, instagram: parsed.instagram, assigned: !!a, zone: r.zone });
  }
  saveRes();
  res.json({ ok: true, count: results.length, results });
});

// Manual reminder trigger
app.post('/api/send-reminders', (_req, res) => { sendReminders(); res.json({ ok: true }); });

// ═════════════════════════════════════════════════════════════
//  CLEANUP & SERVER START
// ═════════════════════════════════════════════════════════════
function cleanup() {
  const cut = Date.now() - 7 * 86400000;
  const before = reservations.length;
  reservations = reservations.filter(r => new Date(r.date+'T23:59:59+09:00').getTime() > cut);
  if (reservations.length !== before) { console.log('Cleaned '+(before-reservations.length)); saveRes(); }
}

app.listen(CONFIG.PORT, () => {
  cleanup();
  sendReminders();
  syncGoogleCalendar();
  autoBackup();
  recoverTimers();
  scheduleDailyReset();
  setInterval(sendReminders,       30 * 60000);
  setInterval(syncGoogleCalendar,  60 * 60000);
  setInterval(autoBackup,          60 * 60000);

  const kakaoReady = CONFIG.KAKAO_SENDER_KEY && CONFIG.KAKAO_SENDER_KEY.length > 0 && CONFIG.KAKAO_SENDER_KEY !== 'YOUR_SENDER_KEY';
  console.log(`\n${CONFIG.BUSINESS_EMOJI}  ${CONFIG.BUSINESS_NAME} Unified System started`);
  console.log(`   Port           : ${CONFIG.PORT}`);
  console.log(`   Reservation    : ${CONFIG.PUBLIC_URL}/reserve.html`);
  console.log(`   Waiting        : ${CONFIG.PUBLIC_URL}/customer.html`);
  console.log(`   Staff Dashboard: ${CONFIG.PUBLIC_URL}/manage.html`);
  console.log(`   Cocktail Lab   : ${CONFIG.PUBLIC_URL}/game.html`);
  console.log(`   Korean SMS     : ${IS_DEV ? '🟡 Simulation' : '✅ Aligo live'}`);
  console.log(`   Alimtalk       : ${kakaoReady ? '✅ Connected' : '⚠️  Not configured'}`);
  console.log(`   Intl SMS       : ${IS_TWILIO_READY ? '✅ Twilio live' : '🟡 Simulation'}`);
  const emailMode = IS_RESEND_READY ? '✅ Resend live' : (IS_GMAIL_READY ? '✅ Gmail live' : '🟡 Not configured');
  console.log(`   Email          : ${emailMode}`);
  console.log(`   Waiting auto-cancel: ${CONFIG.AUTO_CANCEL_MIN} min`);
  console.log(`   Reservations loaded: ${reservations.length}`);
  console.log(`   Queue loaded       : ${queue.length}\n`);
});
