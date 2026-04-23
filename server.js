const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

// Google Sheets webhook (Apps Script)
const SHEETS_WEBHOOK = 'https://script.google.com/macros/s/AKfycbwjrCc045OGvWcHFyMXpW0yZLozPhRJgWIuimozptylSWYE9A-KS9o28PAC3NceNb7Dwg/exec';

// POST with redirect follow (Google Apps Script returns 302)
function postWithRedirect(targetUrl, body) {
  const url = new URL(targetUrl);
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  };
  const req = https.request(options, (res) => {
    if (res.statusCode === 302 || res.statusCode === 301) {
      const loc = res.headers.location;
      if (loc) {
        https.get(loc, (r2) => {
          let b = ''; r2.on('data', d => b += d);
          r2.on('end', () => console.log(`📊 Sheets (reserve): ${b.slice(0, 80)}`));
        }).on('error', e => console.error('Sheets redirect error:', e.message));
      }
    } else {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => console.log(`📊 Sheets (reserve): ${b.slice(0, 80)}`));
    }
  });
  req.on('error', e => console.error('Sheets error:', e.message));
  req.write(data);
  req.end();
}

// ╔══════════════════════════════════════════════════════════════╗
// ║                    ⚙️  CONFIG                                ║
// ╚══════════════════════════════════════════════════════════════╝
const CONFIG = {
  PORT           : process.env.PORT || 3001,
  STAFF_PIN      : process.env.STAFF_PIN || "1234",
  BUSINESS_PHONE : "010-6817-0406",

  // Seat inventory
  SEATS: {
    tables:     ['T1','T2','T3','T4'],       // 4-person tables
    highTables: ['H1','H2'],                  // 2-person high tables
    bar:        Array.from({length:14},(_,i)=>`B${i+1}`), // B1-B14
    room:       ['ROOM'],                     // 1 room, max 8pax, 300K min charge
  },

  CAPACITY: {
    T1:5, T2:5, T3:5, T4:5,   // tables: max 5 each
    H1:2, H2:2,                 // high tables: max 2 each
    B1:1,B2:1,B3:1,B4:1,B5:1,B6:1,B7:1,B8:1,B9:1,B10:1,B11:1,B12:1,B13:1,B14:1,
    ROOM:10,                    // room: 6-10 people
  },

  ROOM_MIN_GUESTS: 6,          // room requires minimum 6 guests

  ROOM_MIN_CHARGE: 300000,  // KRW

  // Reservation time slots (1-hour units)
  // Weekday (Sun-Thu): 19:00, 20:00, 21:00
  // Weekend (Fri, Sat): 19:00, 20:00
  SLOTS_WEEKDAY: ['19:00','20:00','21:00'],
  SLOTS_WEEKEND: ['19:00','20:00'],
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════════════════════════
   DATA LAYER — persistent disk support
   Set DATA_DIR environment variable in Render to persist data
   across deployments (e.g. DATA_DIR=/var/data)
   ═══════════════════════════════════════════════════════════ */
const DATA_DIR    = process.env.DATA_DIR || __dirname;
const DATA_FILE   = path.join(DATA_DIR, 'reservations.json');
const BACKUP_FILE = path.join(DATA_DIR, 'reservations.backup.json');

// Ensure DATA_DIR exists
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

let reservations = [];
let opLock = false;

function saveData () {
  const tmp = DATA_FILE + '.tmp';
  const data = JSON.stringify(reservations, null, 2);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, DATA_FILE);
    fs.writeFileSync(BACKUP_FILE, data, 'utf8');
  } catch (e) {
    console.error('⚠️  SAVE ERROR:', e.message);
    try { fs.writeFileSync(DATA_FILE, data, 'utf8'); } catch {}
  }
}

function loadData () {
  let raw = null;
  try { if (fs.existsSync(DATA_FILE)) raw = fs.readFileSync(DATA_FILE, 'utf8'); } catch {}
  if (!raw) { try { if (fs.existsSync(BACKUP_FILE)) raw = fs.readFileSync(BACKUP_FILE, 'utf8'); } catch {} }
  if (!raw) { reservations = []; return; }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Not array');
    reservations = parsed.filter(r =>
      r && typeof r.id === 'string' && typeof r.name === 'string'
      && typeof r.date === 'string' && typeof r.time === 'string'
    );
  } catch (e) {
    console.error('⚠️  CORRUPT data, starting fresh:', e.message);
    reservations = []; saveData();
  }
}
loadData();

async function withLock (fn) {
  let waited = 0;
  while (opLock) { await new Promise(r => setTimeout(r, 10)); waited += 10; if (waited > 3000) { opLock = false; break; } }
  opLock = true;
  try { return await fn(); } finally { opLock = false; }
}

function uid () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ═══════════════════════════════════════════════════════════
   AUTO-ASSIGNMENT ALGORITHM
   ═══════════════════════════════════════════════════════════ */

function getOccupiedSeats (date, time) {
  // ══════════════════════════════════════════════════════════
  // OVERBOOKING PREVENTION:
  // 1. Same time slot: all confirmed + seated reservations
  // 2. Earlier time slots: only 'seated' (guest physically there)
  //    → prevents double-booking when guests stay longer
  // ══════════════════════════════════════════════════════════
  const seats = [];

  // Helper: convert "HH:MM" to minutes for comparison
  function toMin(t) {
    const [h, m] = t.split(':').map(Number);
    return (h < 6 ? h + 24 : h) * 60 + m;  // 00:00-05:59 → next day
  }
  const reqMin = toMin(time);

  reservations
    .filter(r => r.date === date && r.status !== 'cancelled' && r.status !== 'noshow')
    .forEach(r => {
      const rMin = toMin(r.time);
      if (rMin === reqMin) {
        // Same time: include confirmed + seated
        (r.assignedSeats || []).forEach(s => seats.push(s));
      } else if (rMin < reqMin && r.status === 'seated') {
        // Earlier time, still seated: include (guest still there)
        (r.assignedSeats || []).forEach(s => seats.push(s));
      }
    });

  return seats;
}

function getAvailableSlots (date) {
  const d = new Date(date + 'T00:00:00+09:00'); // KST
  const day = d.getDay(); // 0=Sun ... 5=Fri, 6=Sat
  return (day === 5 || day === 6) ? CONFIG.SLOTS_WEEKEND : CONFIG.SLOTS_WEEKDAY;
}

function autoAssign (zone, partySize, date, time) {
  const occupied = new Set(getOccupiedSeats(date, time));

  // ══════════════════════════════════════════════
  // STRICT SEATING RULES — DO NOT MODIFY
  // Bar (B1-B14): 1 person per seat
  // High table (H1, H2): max 2 people
  // Table (T1-T4): 3-5 people (NEVER seat 2 at table)
  // Room: 6-10 people only
  // ══════════════════════════════════════════════

  if (zone === 'room') {
    if (partySize < CONFIG.ROOM_MIN_GUESTS) return { error: `The private room is for parties of ${CONFIG.ROOM_MIN_GUESTS} or more.` };
    if (partySize > 10) return { error: 'Room accommodates up to 10 guests.' };
    if (occupied.has('ROOM')) return { error: 'Room is fully booked for this time slot.' };
    return { seats: ['ROOM'] };
  }

  if (zone === 'bar') {
    // Bar seats: ALWAYS 1 person per seat
    // 1 person = 1 bar seat, 2 people = 2 consecutive bar seats, etc.
    const barSeats = CONFIG.SEATS.bar;
    const freeBar = barSeats.filter(s => !occupied.has(s));

    if (partySize > 2) {
      return { error: 'Bar seating is for 1-2 guests only. For larger parties, please choose Table or Room.' };
    }
    if (freeBar.length < partySize) {
      return { error: 'No bar seats available for this time slot.' };
    }

    if (partySize === 1) {
      // 1 person: prefer edge seats first (B1, B14, then B2, B13...)
      const edgeOrder = [0,13,1,12,2,11,3,10,4,9,5,8,6,7];
      for (const idx of edgeOrder) {
        if (!occupied.has(barSeats[idx])) return { seats: [barSeats[idx]] };
      }
    }

    if (partySize === 2) {
      // 2 people: prefer high tables first, then consecutive bar seats
      const freeHigh = CONFIG.SEATS.highTables.filter(s => !occupied.has(s));
      if (freeHigh.length > 0) return { seats: [freeHigh[0]] };

      // Find consecutive bar seats
      for (let i = 0; i < barSeats.length - 1; i++) {
        if (!occupied.has(barSeats[i]) && !occupied.has(barSeats[i+1])) {
          return { seats: [barSeats[i], barSeats[i+1]] };
        }
      }
      // No consecutive? Still assign 2 separate seats
      if (freeBar.length >= 2) return { seats: freeBar.slice(0, 2) };
      return { error: 'Not enough bar seats available for this time slot.' };
    }

    return { seats: freeBar.slice(0, partySize) };
  }

  if (zone === 'table') {
    // 1-2 people: high table ONLY, or redirect to bar
    if (partySize <= 2) {
      const freeHigh = CONFIG.SEATS.highTables.filter(s => !occupied.has(s));
      if (freeHigh.length > 0) return { seats: [freeHigh[0]] };
      // NO tables for 2 people — redirect
      return { error: 'High tables are fully booked. Bar seating is available — would you like a bar seat instead?' };
    }

    // 3-5 people: table (T1-T4, capacity 5 each)
    if (partySize >= 3 && partySize <= 5) {
      const freeTable = CONFIG.SEATS.tables.filter(s => !occupied.has(s));
      if (freeTable.length > 0) return { seats: [freeTable[0]] };
      return { error: 'No tables available for this time slot.' };
    }

    // 6+ people: must use room
    if (partySize >= 6) {
      return { error: `For parties of ${partySize}, please select the Private Room.` };
    }

    return { error: 'No seats available for this party size.' };
  }

  return { error: 'Invalid zone.' };
}

/* ═══════════════════════════════════════════════════════════
   API ROUTES
   ═══════════════════════════════════════════════════════════ */

// Public config
app.get('/api/config', (_req, res) => {
  res.json({
    staffPin      : CONFIG.STAFF_PIN,
    businessPhone : CONFIG.BUSINESS_PHONE,
    roomMinCharge : CONFIG.ROOM_MIN_CHARGE,
    seats         : CONFIG.SEATS,
    capacity      : CONFIG.CAPACITY,
  });
});

// Get available slots for a date
app.get('/api/availability/:date', (req, res) => {
  const { date } = req.params;
  const slots = getAvailableSlots(date);

  // Same-day cutoff: if today and past 5 PM KST, return empty
  const nowKST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayKST = nowKST.toISOString().slice(0, 10);
  if (date === todayKST && nowKST.getUTCHours() * 60 + nowKST.getUTCMinutes() >= 8 * 60) {
    return res.json({ date, slots: [], availability: {}, occupied: {}, closed: true,
      message: 'Same-day reservations are closed after 5 PM.\n당일 예약은 오후 5시에 마감됩니다.' });
  }

  const occupied = {};

  slots.forEach(time => {
    const taken = getOccupiedSeats(date, time);
    occupied[time] = taken;
  });

  // Calculate availability per zone per slot
  const availability = {};
  slots.forEach(time => {
    const taken = new Set(occupied[time]);
    availability[time] = {
      bar:   CONFIG.SEATS.bar.filter(s => !taken.has(s)).length,
      table: CONFIG.SEATS.tables.filter(s => !taken.has(s)).length
           + CONFIG.SEATS.highTables.filter(s => !taken.has(s)).length,
      room:  taken.has('ROOM') ? 0 : 1,
    };
  });

  res.json({ date, slots, availability, occupied });
});

// Get all reservations for a date (staff)
app.get('/api/reservations/:date', (req, res) => {
  const dayRes = reservations.filter(r => r.date === req.params.date && r.status !== 'cancelled');
  res.json(dayRes);
});

// Get all reservations (staff - for date range)
app.get('/api/reservations', (_req, res) => {
  res.json(reservations.filter(r => r.status !== 'cancelled'));
});

// ── Guest/Staff: make a reservation ──
app.post('/api/reserve', async (req, res) => {
  try {
    const result = await withLock(async () => {
      const { name, phone, partySize, zone, date, time } = req.body;

      if (!name?.trim()) return { status: 400, body: { error: 'Please enter your name.' } };
      if (!phone?.trim()) return { status: 400, body: { error: 'Please enter your phone number.' } };
      if (!date || !time) return { status: 400, body: { error: 'Please select a date and time.' } };
      if (!['bar','table','room'].includes(zone)) return { status: 400, body: { error: 'Please select a zone.' } };

      const size = Math.max(1, Math.min(20, parseInt(partySize) || 2));

      // Validate time slot
      const validSlots = getAvailableSlots(date);
      if (!validSlots.includes(time))
        return { status: 400, body: { error: 'This time slot is not available for the selected date.' } };

      // Same-day cutoff: no reservations after 5 PM KST on the same day
      const nowKST = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const todayKST = nowKST.toISOString().slice(0, 10);
      if (date === todayKST && nowKST.getUTCHours() * 60 + nowKST.getUTCMinutes() >= 8 * 60) {
        // 5 PM KST = 08:00 UTC
        return { status: 400, body: { error: 'Same-day reservations are closed after 5 PM. Please call us or walk in.\n당일 예약은 오후 5시에 마감됩니다. 전화 또는 방문 부탁드립니다.' } };
      }

      // Prevent duplicate: same phone + same date
      const existing = reservations.find(r =>
        r.phone.replace(/-/g,'') === phone.trim().replace(/-/g,'')
        && r.date === date && r.status !== 'cancelled' && r.status !== 'noshow'
      );
      if (existing)
        return { status: 409, body: { error: 'You already have a reservation for this date.', existing } };

      // Auto-assign seats
      const assignment = autoAssign(zone, size, date, time);
      if (assignment.error)
        return { status: 409, body: { error: assignment.error, suggestRoom: assignment.suggestRoom } };

      const entry = {
        id: uid(),
        name: name.trim(),
        phone: phone.trim(),
        partySize: size,
        zone,
        date,
        time,
        assignedSeats: assignment.seats,
        status: 'confirmed',
        createdAt: Date.now(),
      };

      reservations.push(entry);
      saveData();

      // Save to Google Sheets (예약로그 tab)
      const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
      postWithRedirect(SHEETS_WEBHOOK, {
        type: 'reservation',
        접수시간: kst.toISOString().replace('T',' ').slice(0,19),
        확인코드: entry.id,
        예약날짜: entry.date,
        시간: entry.time,
        이름: entry.name,
        인원: entry.partySize,
        전화번호: entry.phone || '',
        이메일: entry.email || '',
        인스타: entry.instagram || '',
        좌석타입: entry.zone,
        좌석번호: (entry.assignedSeats || []).join(','),
        예약경로: req.body.source || 'online',
        특이사항: req.body.notes || '',
        상태: 'confirmed',
      });

      return { status: 200, body: entry };
    });

    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('RESERVE error:', e);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── Staff: update reservation status (seated/noshow → remove from active) ──
app.post('/api/reservations/:id/status', async (req, res) => {
  try {
    await withLock(async () => {
      const entry = reservations.find(r => r.id === req.params.id);
      if (!entry) return;
      const { status } = req.body;
      if (['seated','noshow'].includes(status)) {
        entry.status = status;
        if (status === 'seated') entry.seatedAt = Date.now();
        if (status === 'noshow') entry.noshowAt = Date.now();
        saveData();
      }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('STATUS error:', e);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Staff: edit reservation (time + party size) ──
app.post('/api/reservations/:id/edit', async (req, res) => {
  try {
    const result = await withLock(async () => {
      const entry = reservations.find(r => r.id === req.params.id);
      if (!entry) return { status: 404, body: { error: 'Reservation not found.' } };

      const { time, partySize } = req.body;
      const newSize = partySize ? Math.max(1, Math.min(10, parseInt(partySize))) : entry.partySize;
      const newTime = time || entry.time;

      // If size changed, re-assign seats
      if (newSize !== entry.partySize || newTime !== entry.time) {
        // Remove this reservation's seats from occupied calculation
        const oldSeats = entry.assignedSeats || [];
        const occupied = new Set(getOccupiedSeats(entry.date, newTime).filter(s => !oldSeats.includes(s)));

        // Re-assign based on new size
        let newSeats = oldSeats;
        if (newSize !== entry.partySize) {
          const assignment = autoAssign(entry.zone, newSize, entry.date, newTime);
          if (assignment.error) return { status: 409, body: { error: assignment.error } };
          newSeats = assignment.seats;
        }

        entry.time = newTime;
        entry.partySize = newSize;
        entry.assignedSeats = newSeats;
      } else {
        entry.time = newTime;
      }

      saveData();
      return { status: 200, body: { ok: true, entry } };
    });
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('EDIT error:', e);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Staff: delete reservation ──
app.delete('/api/reservations/:id', async (req, res) => {
  try {
    await withLock(async () => {
      reservations = reservations.filter(r => r.id !== req.params.id);
      saveData();
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE error:', e);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Auto-cleanup: remove old reservations (older than 30 days) ──
function cleanup () {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const before = reservations.length;
  reservations = reservations.filter(r => {
    const rDate = new Date(r.date + 'T23:59:59+09:00').getTime();
    return rDate > cutoff;
  });
  if (reservations.length !== before) {
    console.log(`🧹 Cleaned ${before - reservations.length} old reservations`);
    saveData();
  }
}

/* ═══════════════════════════════════════════════════════════
   REMINDER SYSTEM
   Day before (D-1) + Day of (D-0) confirmation SMS
   Checks every 30 minutes
   ═══════════════════════════════════════════════════════════ */

function getTodayKST () {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function getTomorrowKST () {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function buildReminderSMS (entry, type) {
  const biz = CONFIG.BUSINESS_PHONE;
  const zoneNames = { bar: 'Bar', table: 'Table', room: 'Private Room' };
  const seats = (entry.assignedSeats || []).join(', ');
  const zn = zoneNames[entry.zone] || entry.zone;

  if (type === 'dayBefore') {
    return `[PINE&CO]\n`
      + `${entry.name}님, 내일 예약을 확인드립니다.\n`
      + `날짜: ${entry.date} ${entry.time}\n`
      + `인원: ${entry.partySize}명 / ${zn} (${seats})\n`
      + `\n`
      + `${entry.name}, this is a reminder for your reservation tomorrow.\n`
      + `Date: ${entry.date} ${entry.time}\n`
      + `Party: ${entry.partySize} / ${zn} (${seats})\n`
      + `\n`
      + `예약 취소는 전화로 부탁드립니다.\n`
      + `To cancel, please call us.\n`
      + `Tel: ${biz}`;
  }

  // Day of
  return `[PINE&CO]\n`
    + `${entry.name}님, 오늘 예약을 다시 확인드립니다.\n`
    + `시간: ${entry.time} / ${entry.partySize}명 / ${zn}\n`
    + `\n`
    + `${entry.name}, a reminder for your reservation today.\n`
    + `Time: ${entry.time} / ${entry.partySize} guests / ${zn}\n`
    + `\n`
    + `예약 취소는 전화로 부탁드립니다.\n`
    + `To cancel, please call us.\n`
    + `Tel: ${biz}`;
}

async function sendReminders () {
  const today = getTodayKST();
  const tomorrow = getTomorrowKST();
  let changed = false;

  for (const r of reservations) {
    if (r.status === 'cancelled' || r.status === 'noshow' || r.status === 'seated') continue;

    // Day-before reminder
    if (r.date === tomorrow && !r.reminderD1Sent) {
      const msg = buildReminderSMS(r, 'dayBefore');
      console.log(`📩 D-1 reminder → ${r.name} (${r.date} ${r.time})`);
      console.log(`   ${msg.split('\n')[0]}...`);
      // TODO: integrate with Aligo/Twilio sendMessage when ready
      r.reminderD1Sent = true;
      changed = true;
    }

    // Day-of reminder
    if (r.date === today && !r.reminderD0Sent) {
      const msg = buildReminderSMS(r, 'dayOf');
      console.log(`📩 D-0 reminder → ${r.name} (${r.date} ${r.time})`);
      console.log(`   ${msg.split('\n')[0]}...`);
      // TODO: integrate with Aligo/Twilio sendMessage when ready
      r.reminderD0Sent = true;
      changed = true;
    }
  }

  if (changed) saveData();
}

// Staff can trigger reminders manually
app.post('/api/send-reminders', async (_req, res) => {
  await sendReminders();
  res.json({ ok: true, message: 'Reminders processed' });
});

// No-show stats endpoint
app.get('/api/stats/noshow', (_req, res) => {
  const total = reservations.length;
  const noshows = reservations.filter(r => r.status === 'noshow').length;
  const rate = total > 0 ? Math.round(noshows / total * 100) : 0;
  res.json({ total, noshows, rate: rate + '%' });
});

// ── Walk-in seat tracking (in-memory, resets on restart) ──
let walkinSeats = {};  // { "2026-04-23_19:00": ["B3","B5"] }

app.get('/api/walkin/:date/:time', (req, res) => {
  const key = req.params.date + '_' + req.params.time;
  res.json({ seats: walkinSeats[key] || [] });
});

app.post('/api/walkin/toggle', (req, res) => {
  const { date, time, seat } = req.body;
  if (!date || !time || !seat) return res.status(400).json({ error: 'Missing fields' });
  const key = date + '_' + time;
  if (!walkinSeats[key]) walkinSeats[key] = [];
  const idx = walkinSeats[key].indexOf(seat);
  if (idx >= 0) walkinSeats[key].splice(idx, 1);
  else walkinSeats[key].push(seat);
  res.json({ seats: walkinSeats[key] });
});

/* ─── Start ─── */
app.listen(CONFIG.PORT, () => {
  cleanup();
  sendReminders();
  // Check reminders every 30 minutes
  setInterval(sendReminders, 30 * 60 * 1000);

  console.log(`\n🌲 PINE&CO Reservation System started`);
  console.log(`   Guest page  : http://localhost:${CONFIG.PORT}/reserve.html`);
  console.log(`   Staff page  : http://localhost:${CONFIG.PORT}/manage.html`);
  console.log(`   Reminders   : Auto-check every 30 min (D-1 + D-0)`);
  console.log(`   Reservations: ${reservations.length} entries loaded\n`);
});
