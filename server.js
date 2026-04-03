const express = require('express');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  PORT: process.env.PORT || 3001,
  STAFF_PIN: process.env.STAFF_PIN || '1234',
  BUSINESS_PHONE: process.env.BUSINESS_PHONE || '02-XXX-XXXX',
  PUBLIC_URL: process.env.PUBLIC_URL || 'http://localhost:3001',
  BUSINESS_HOURS: '19:00 - 02:00',
  ALIGO_KEY: process.env.ALIGO_KEY || '',
  ALIGO_USER_ID: process.env.ALIGO_USER_ID || '',
  ALIGO_SENDER: process.env.ALIGO_SENDER || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  RESEND_FROM: process.env.RESEND_FROM || 'Pine & Co <noreply@pineandco.shop>',
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
const STAFF_NAMES = ['DuUi','Manager','Staff1','Staff2'];

const DATA_FILE = path.join(__dirname, 'reservations.json');
const EVENTS_FILE = path.join(__dirname, 'events.json');
let reservations = [], events = {};
let lockPromise = Promise.resolve();
function withLock(fn) { lockPromise = lockPromise.then(fn).catch(e => { console.error(e); throw e; }); return lockPromise; }

function loadData() {
  try { if (fs.existsSync(DATA_FILE)) reservations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { reservations = []; }
  try { if (fs.existsSync(EVENTS_FILE)) events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch(e) { events = {}; }
  console.log(`Loaded ${reservations.length} reservations, ${Object.keys(events).length} events`);
}
function saveRes() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(reservations, null, 2)); } catch(e) { console.error(e); } }
function saveEvents() { try { fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2)); } catch(e) { console.error(e); } }
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

// ── Guest reserve ──
app.post('/api/reserve', async (req, res) => {
  const { name, phone, instagram, email, partySize, date, time, preference } = req.body;
  if (!name || !partySize || !date || !time) return res.status(400).json({ error: 'Required fields missing.' });
  if (partySize < 1 || partySize > 10) return res.status(400).json({ error: 'Party size 1-10.' });
  if (events[date]) return res.status(400).json({ error: 'This date is not available (event).' });
  const slots = getSlots(date);
  if (!slots.includes(time)) return res.status(400).json({ error: 'Invalid time.' });
  try {
    await withLock(async () => {
      const a = autoAssign(date, time, partySize, preference);
      if (!a) throw new Error('해당 시간에 좌석이 없습니다. / No seats available.');
      const r = {
        id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
        name, phone: phone||'', instagram: instagram||'', email: email||'',
        partySize, date, time, preference: preference||'',
        zone: a.zone, seats: a.seats, status: 'confirmed', source: 'online',
        notes: '', createdAt: new Date().toISOString(),
        reminderD1: false, reminderD0: false, modLog: [],
      };
      reservations.push(r); saveRes();
      sendConfirmation(r);
      res.json({ ok: true, reservation: r });
    });
  } catch(e) { res.status(409).json({ error: e.message }); }
});

// ── Staff routes ──
app.get('/api/staff-names', (req, res) => res.json(STAFF_NAMES));
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

// ── SMS ──
function sendSMS(to, msg) {
  if (!CONFIG.ALIGO_KEY) { console.log('📱 [SIM] '+to+'\n'+msg+'\n'); return; }
  const p = new URLSearchParams({ key:CONFIG.ALIGO_KEY, user_id:CONFIG.ALIGO_USER_ID, sender:CONFIG.ALIGO_SENDER, receiver:to.replace(/[^0-9+]/g,''), msg, msg_type:'LMS' });
  fetch('https://apis.aligo.in/send/',{method:'POST',body:p}).then(r=>r.json()).then(d=>console.log('SMS:',d)).catch(e=>console.error(e));
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

function cleanup() {
  const cut=Date.now()-7*86400000, b=reservations.length;
  reservations=reservations.filter(r=>new Date(r.date+'T23:59:59+09:00').getTime()>cut);
  if(reservations.length!==b){ console.log('Cleaned '+(b-reservations.length)); saveRes(); }
}

app.listen(CONFIG.PORT, () => {
  cleanup(); sendReminders(); setInterval(sendReminders, 30*60000);
  console.log('\n🌲 PINE&CO Reserve | http://localhost:'+CONFIG.PORT+'\n');
});
