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
const STAFF_FILE = path.join(__dirname, 'staff.json');
const DATA_FILE = path.join(__dirname, 'reservations.json');
const EVENTS_FILE = path.join(__dirname, 'events.json');
let reservations = [], events = {}, staffNames = ['DuUi','Manager'];
let lockPromise = Promise.resolve();
function withLock(fn) { lockPromise = lockPromise.then(fn).catch(e => { console.error(e); throw e; }); return lockPromise; }

function loadData() {
  try { if (fs.existsSync(DATA_FILE)) reservations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { reservations = []; }
  try { if (fs.existsSync(EVENTS_FILE)) events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch(e) { events = {}; }
  try { if (fs.existsSync(STAFF_FILE)) staffNames = JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8')); } catch(e) {}
  console.log(`Loaded ${reservations.length} reservations, ${Object.keys(events).length} events, ${staffNames.length} staff`);
}
function saveRes() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(reservations, null, 2)); } catch(e) { console.error(e); } }
function saveEvents() { try { fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2)); } catch(e) { console.error(e); } }
function saveStaff() { try { fs.writeFileSync(STAFF_FILE, JSON.stringify(staffNames, null, 2)); } catch(e) { console.error(e); } }
loadData();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function kstToday() { return new Date(Date.now() + 9*3600000).toISOString().slice(0,10); }
function isWeekend(d) { const day = new Date(d+'T12:00:00+09:00').getDay(); return day===0||day===5||day===6; }
function getSlots(d) { return isWeekend(d) ? CONFIG.WEEKEND_SLOTS : CONFIG.WEEKDAY_SLOTS; }
function getResFor(date,time) { return reservations.filter(r => r.date===date && r.time===time && r.status!=='cancelled' && r.status!=='noshow'); }
function getOccupied(date,time) { const s=[]; getResFor(date,time).forEach(r => { if(r.seats) s.push(...r.seats); }); return s; }

function autoAssign(date, time, partySize, preference) {
  const occ = getOccupied(date, time);
  const free = s => !occ.includes(s);

  if (preference === 'bar' || partySize === 1) {
    if (partySize === 1) {
      for (const s of CONFIG.BAR_EDGE_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
      for (const s of CONFIG.BAR_MID_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
      for (const s of CONFIG.BAR_U_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
    }
    if (partySize === 2) {
      const pairs = [['B1','B2'],['B2','B3'],['B4','B5'],['B5','B6'],['B7','B8'],['B8','B9'],['B10','B11'],['B12','B13'],['B13','B14']];
      for (const p of pairs) if (p.every(free)) return { zone:'bar', seats:p };
    }
    return null;
  }

  if (preference === 'table') {
    if (partySize <= 2) {
      for (const s of CONFIG.SEATS.highTables) if (free(s)) return { zone:'highTable', seats:[s] };
      for (const s of CONFIG.SEATS.tables) if (free(s)) return { zone:'table', seats:[s] };
    }
    if (partySize >= 3 && partySize <= 5) {
      for (const s of CONFIG.SEATS.tables) if (free(s)) return { zone:'table', seats:[s] };
    }
    if (partySize >= 6 && partySize <= 10) {
      if (free('ROOM')) return { zone:'room', seats:['ROOM'], note: partySize >= 9 ? 'tight_room' : null };
    }
    return null;
  }

  // auto (no preference)
  if (partySize === 1) {
    for (const s of CONFIG.BAR_EDGE_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
    for (const s of CONFIG.BAR_MID_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
    for (const s of CONFIG.BAR_U_SEATS) if (free(s)) return { zone:'bar', seats:[s] };
  }
  if (partySize === 2) {
    for (const s of CONFIG.SEATS.highTables) if (free(s)) return { zone:'highTable', seats:[s] };
    const pairs = [['B1','B2'],['B2','B3'],['B4','B5'],['B5','B6'],['B7','B8'],['B8','B9'],['B10','B11'],['B12','B13'],['B13','B14']];
    for (const p of pairs) if (p.every(free)) return { zone:'bar', seats:p };
    for (const s of CONFIG.SEATS.tables) if (free(s)) return { zone:'table', seats:[s] };
  }
  if (partySize >= 3 && partySize <= 5) {
    for (const s of CONFIG.SEATS.tables) if (free(s)) return { zone:'table', seats:[s] };
  }
  if (partySize >= 6 && partySize <= 10) {
    if (free('ROOM')) return { zone:'room', seats:['ROOM'], note: partySize >= 9 ? 'tight_room' : null };
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
  const result = {};
  slots.forEach(time => {
    const occ = getOccupied(date, time);
    const isLate = time === CONFIG.LATE_SLOT && !isWeekend(date);
    let barFree = CONFIG.SEATS.bar.filter(s => !occ.includes(s)).length;
    let tablesFree = CONFIG.SEATS.tables.filter(s => !occ.includes(s)).length;
    const highFree = CONFIG.SEATS.highTables.filter(s => !occ.includes(s)).length;
    const roomFree = !occ.includes('ROOM') ? 1 : 0;
    if (isLate) {
      const ex = getResFor(date, time);
      const ub = ex.filter(r => r.zone==='bar').reduce((s,r) => s+r.partySize, 0);
      const ut = ex.filter(r => r.zone==='table'||r.zone==='highTable').length;
      barFree = Math.max(0, CONFIG.LATE_BAR_MAX - ub);
      tablesFree = Math.max(0, CONFIG.LATE_TABLE_MAX - ut);
    }
    result[time] = { bar:barFree, tables:tablesFree, highTables:highFree, room:roomFree, isLate, occupiedSeats:occ };
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

  // Auto-detect preference from special request or party size
  let preference = detectPreference(specialRequest, partySize);
  if (preference === 'room_request') {
    if (partySize < 6) preference = 'table'; // room requested but too few people
    else preference = null; // will auto-assign to room via partySize logic
  }
  if (!preference) {
    // Default: 1-2 → bar, 3+ → table
    if (partySize <= 2) preference = null; // auto (tries highTable/bar)
    else preference = 'table';
  }

  try {
    await withLock(async () => {
      const a = autoAssign(date, time, partySize, preference);
      if (!a) throw new Error('해당 시간에 좌석이 없습니다. / No seats available.');
      const r = {
        id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
        name, phone: phone||'', instagram: instagram||'', email: email||'',
        partySize, date, time, preference: preference||'auto',
        zone: a.zone, seats: a.seats, status: 'confirmed', source: 'online',
        notes: specialRequest||'', createdAt: new Date().toISOString(),
        reminderD1: false, reminderD0: false, modLog: [],
      };
      reservations.push(r); saveRes();
      sendConfirmation(r);
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
  reservations.forEach(r => { if (r.date.startsWith(prefix) && r.status!=='cancelled') counts[r.date]=(counts[r.date]||0)+1; });
  res.json(counts);
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
    createdAt: new Date().toISOString(), reminderD1:false, reminderD0:false,
    modLog: [{ action:'created', by:staffName||'Staff', at:new Date().toISOString() }],
  };
  reservations.push(r); saveRes();
  res.json({ ok:true, reservation:r });
});
app.get('/api/reservations/:date', (req, res) => {
  res.json(reservations.filter(r => r.date===req.params.date && r.status!=='cancelled'));
});
// Get all reservations created today (new bookings)
app.get('/api/new-today', (req, res) => {
  const today = kstToday();
  const newOnes = reservations.filter(r => r.createdAt && r.createdAt.startsWith(today) && r.status!=='cancelled');
  res.json(newOnes);
});
app.patch('/api/reservations/:id', (req, res) => {
  const r = reservations.find(x => x.id===req.params.id);
  if (!r) return res.status(404).json({ error:'Not found' });
  const ch = [];
  if (req.body.status && req.body.status!==r.status) { ch.push('status:'+r.status+'→'+req.body.status); r.status=req.body.status; }
  if (req.body.notes!==undefined && req.body.notes!==r.notes) { ch.push('notes updated'); r.notes=req.body.notes; }
  if (req.body.source && req.body.source!==r.source) { ch.push('source:'+r.source+'→'+req.body.source); r.source=req.body.source; }
  if (ch.length) { if(!r.modLog)r.modLog=[]; r.modLog.push({ action:ch.join(', '), by:req.body.staffName||'Staff', at:new Date().toISOString() }); }
  saveRes(); res.json({ ok:true, reservation:r });
});
app.delete('/api/reservations/:id', (req, res) => {
  reservations = reservations.filter(r => r.id!==req.params.id); saveRes(); res.json({ ok:true });
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
// Examples: "Sasha / 7:30 / 2pax / 01083484036 / 명준"
//           "Kim / 8pm / 4명 / @kimbar / DuUi"
//           "John 20:00 3 table 010-1234-5678"
function parseGcalEntry(text) {
  const result = { name:'Guest', time:null, partySize:2, phone:'', instagram:'', staffName:'', raw:text };
  if (!text) return result;

  // Split by / , · or multiple spaces
  const parts = text.split(/[\/·,]|\s{2,}/).map(s => s.trim()).filter(Boolean);
  const unmatched = [];

  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;

    // Instagram handle: starts with @
    if (/^@/.test(p)) { result.instagram = p; continue; }

    // Time patterns: 7:30, 19:00, 8pm, 8PM, 오후8시, etc.
    const timeMatch = p.match(/^(\d{1,2})\s*:\s*(\d{2})\s*(pm|am)?$/i)
      || p.match(/^(\d{1,2})\s*(pm|PM|am|AM)$/)
      || p.match(/^오후\s*(\d{1,2})\s*시?$/);
    if (timeMatch && !result.time) {
      let h = parseInt(timeMatch[1]);
      const ampm = (timeMatch[3] || timeMatch[2] || '').toLowerCase();
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      if (timeMatch[0].startsWith('오후') && h < 12) h += 12;
      if (h < 12) h += 12; // assume PM for bar hours
      result.time = String(h).padStart(2, '0') + ':00';
      result.exactTime = p;
      continue;
    }

    // Party size: 2pax, 3명, 4people, 5p
    const paxMatch = p.match(/^(\d{1,2})\s*(pax|명|people|persons|guests|p|PAX)$/i);
    if (paxMatch) { result.partySize = parseInt(paxMatch[1]); continue; }
    // Standalone small number (1-10) likely party size
    if (/^\d{1,2}$/.test(p) && parseInt(p) >= 1 && parseInt(p) <= 10 && !result._gotPax) {
      result.partySize = parseInt(p); result._gotPax = true; continue;
    }

    // Phone number: 010-xxxx-xxxx, +82-10-xxxx-xxxx, or 8+ digits
    const phoneClean = p.replace(/[\s\-().]/g, '');
    if (/^[\+]?\d{8,15}$/.test(phoneClean)) { result.phone = phoneClean; continue; }
    // Also catch shorter Korean mobile: 010xxxxxxxx pattern within text
    if (/^01[0-9][\-\s]?\d{3,4}[\-\s]?\d{4}$/.test(p)) { result.phone = phoneClean; continue; }

    // Everything else is text
    unmatched.push(p);
  }

  // First unmatched = guest name
  if (unmatched.length >= 1) result.name = unmatched[0];
  // If 2+ unmatched, last one = staff name (but NOT if it's a known keyword)
  if (unmatched.length >= 2) {
    const last = unmatched[unmatched.length - 1];
    // Don't treat keywords as staff
    if (!/^(bar|table|room|바|테이블|룸|counter|private)$/i.test(last)) {
      result.staffName = last;
    }
  }

  delete result._gotPax;
  return result;
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
      timeMin: now.toISOString(),
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
      const time = parsed.time || fallbackTime;
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
        createdAt: new Date().toISOString(), reminderD1: false, reminderD0: false,
        modLog: [{ action: 'Google Calendar import' + (a ? '' : ' (⚠️미배정)'), by: parsed.staffName || 'System', at: new Date().toISOString() }],
      });
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
    const r = await cal.events.list({ calendarId: CONFIG.GOOGLE_CALENDAR_ID, timeMin: now.toISOString(), timeMax: twoMonths.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 500 });
    const events = (r.data.items || []).filter(ev => ev.status !== 'cancelled' && (ev.summary || '').trim());
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
  const result = await syncGoogleCalendar();
  res.json({ ok: true, added: result.added, warnings: result.warnings, total: result.total, reservationCount: reservations.length });
});

function cleanup() {
  const cut=Date.now()-7*86400000, b=reservations.length;
  reservations=reservations.filter(r=>new Date(r.date+'T23:59:59+09:00').getTime()>cut);
  if(reservations.length!==b){ console.log('Cleaned '+(b-reservations.length)); saveRes(); }
}

app.listen(CONFIG.PORT, () => {
  cleanup(); sendReminders(); syncGoogleCalendar();
  setInterval(sendReminders, 30*60000);
  setInterval(syncGoogleCalendar, 60*60000); // sync every hour
  console.log('\n🌲 PINE&CO Reserve | http://localhost:'+CONFIG.PORT+'\n');
});
