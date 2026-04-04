const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const qs      = require('querystring');

// ╔══════════════════════════════════════════════════════════════╗
// ║                      ⚙️  CONFIG                              ║
// ╚══════════════════════════════════════════════════════════════╝
const CONFIG = {
  BUSINESS_NAME  : "PINE&CO",
  BUSINESS_EMOJI : "🌲",
  BUSINESS_PHONE : "010-6817-0406",
  STAFF_PIN      : "1234",
  PORT           : process.env.PORT || 3000,

  PUBLIC_URL     : "https://pineandco-waiting.onrender.com",

  // ── Aligo (Korean numbers: SMS + KakaoTalk) ──────────────────
  ALIGO_KEY      : "rh3n2s1roxzkir7k40s2uud6t56n80uk",
  ALIGO_USER_ID  : "pineandcoseoul",
  ALIGO_SENDER   : "01068170406",

  // ── KakaoTalk Alimtalk ───────────────────────────────────────
  KAKAO_SENDER_KEY : "0fb72a35d7e535142a1863909dddd879687eabb8",
  TPL_JOIN   : "YOUR_TPL_CODE_JOIN",
  TPL_CALL   : "YOUR_TPL_CODE_CALL",
  TPL_CANCEL : "YOUR_TPL_CODE_CANCEL",

  // ── Twilio (International numbers) ───────────────────────────
  TWILIO_SID     : "AC4240cb85035b38453f598974ae9d3e91",
  TWILIO_TOKEN   : "00cc76d8377aa69e18237efd37f4c076",
  TWILIO_FROM    : "+12602548266",

  AUTO_CANCEL_MIN : 5,

  // ── Resend (Email notifications) ────────────────────────────
  RESEND_KEY     : "re_Y9vDdV8F_JQCZVN7V19GWb5xH9tdhVSUb",
  EMAIL_FROM     : "Pine & Co Seoul <waiting@pineandco.shop>",
};
// ══════════════════════════════════════════════════════════════

const IS_DEV = !CONFIG.ALIGO_KEY || CONFIG.ALIGO_KEY === 'YOUR_API_KEY';

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (_req, res) => res.redirect('/customer.html'));
// Short URL for SMS (phones detect shorter URLs better)
app.get('/t/:id', (req, res) => res.redirect('/customer.html?id=' + req.params.id));

/* ═══════════════════════════════════════════════════════════
   RELIABILITY LAYER — prevents queue corruption
   ═══════════════════════════════════════════════════════════ */

const DATA_FILE   = path.join(__dirname, 'queue.json');
const BACKUP_FILE = path.join(__dirname, 'queue.backup.json');
let queue        = [];
let cancelTimers = {};
let sseClients   = [];
let opLock       = false;  // operation lock — prevents race conditions

// ── Atomic save: write to temp file first, then rename ──
function saveQueue () {
  const tmp = DATA_FILE + '.tmp';
  const data = JSON.stringify(queue, null, 2);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, DATA_FILE);
    // Keep a backup every save
    fs.writeFileSync(BACKUP_FILE, data, 'utf8');
  } catch (e) {
    console.error('⚠️  SAVE ERROR:', e.message);
    // Fallback: direct write
    try { fs.writeFileSync(DATA_FILE, data, 'utf8'); } catch {}
  }
}

// ── Load with validation + backup recovery ──
function loadQueue () {
  let raw = null;
  try {
    if (fs.existsSync(DATA_FILE))
      raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch { raw = null; }

  // If main file is broken, try backup
  if (!raw || raw.trim() === '') {
    try {
      if (fs.existsSync(BACKUP_FILE))
        raw = fs.readFileSync(BACKUP_FILE, 'utf8');
    } catch { raw = null; }
  }

  if (!raw) { queue = []; return; }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Not an array');
    // Validate each entry has required fields
    queue = parsed.filter(e =>
      e && typeof e.id === 'string' && typeof e.number === 'number'
      && typeof e.name === 'string' && typeof e.phone === 'string'
      && typeof e.status === 'string' && ['waiting','called'].includes(e.status)
      && typeof e.joinedAt === 'number'
    );
    if (queue.length !== parsed.length) {
      console.warn(`⚠️  Removed ${parsed.length - queue.length} invalid entries from queue`);
      saveQueue();
    }
  } catch (e) {
    console.error('⚠️  CORRUPT queue.json, starting fresh:', e.message);
    queue = [];
    saveQueue();
  }
}

loadQueue();

// ── Operation lock: ensures one queue mutation at a time ──
async function withLock (fn) {
  // Simple spin-wait (Node is single-threaded, so this is safe)
  let waited = 0;
  while (opLock) {
    await new Promise(r => setTimeout(r, 10));
    waited += 10;
    if (waited > 3000) { // 3 second timeout
      console.error('⚠️  Lock timeout — forcing unlock');
      opLock = false;
      break;
    }
  }
  opLock = true;
  try { return await fn(); }
  finally { opLock = false; }
}

// ── Get next queue number — guaranteed unique ──
function nextNumber () {
  const used = new Set(queue.map(q => q.number));
  let n = queue.reduce((m, q) => Math.max(m, q.number), 0) + 1;
  while (used.has(n)) n++;  // skip any collision
  return n;
}

// ── Generate unique ID ──
function uid () {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function broadcast () {
  const data = JSON.stringify(queue);
  sseClients = sseClients.filter(r => !r.writableEnded);
  sseClients.forEach(r => r.write(`data: ${data}\n\n`));
  saveQueue();
}

/* ─── HTTP POST helper ─── */
function httpPost (hostname, reqPath, params) {
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
    req.write(body);
    req.end();
  });
}

/* ═══════════════════════════════════════════════════════════
   PHONE NUMBER ROUTING
   Korean numbers  → Aligo (KakaoTalk + SMS)
   International   → Twilio
   ═══════════════════════════════════════════════════════════ */

function isKoreanNumber (phone) {
  const clean = phone.replace(/[-\s()]/g, '');
  // Simple rule: starts with 010 or +82 → Korean
  if (clean.startsWith('010')) return true;
  if (clean.startsWith('+82')) return true;
  if (clean.startsWith('82')) return true;
  return false;
}

// Format phone to E.164 for Twilio (e.g. +821012345678)
function toE164 (phone) {
  let clean = phone.replace(/[-\s()]/g, '');
  // Already has + prefix
  if (clean.startsWith('+')) return clean;
  // Korean number without country code
  if (/^01[0-9]/.test(clean)) return '+82' + clean.slice(1);
  // Number with country code but no +
  if (/^[1-9]\d{6,14}$/.test(clean)) return '+' + clean;
  return '+' + clean;
}

/* ─── Twilio SMS sender ─── */
async function sendTwilio (toPhone, message) {
  const sid   = CONFIG.TWILIO_SID;
  const token = CONFIG.TWILIO_TOKEN;
  const from  = CONFIG.TWILIO_FROM;

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
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const IS_TWILIO_READY = CONFIG.TWILIO_SID !== 'YOUR_TWILIO_SID';
const IS_EMAIL_READY = CONFIG.RESEND_KEY !== 'YOUR_RESEND_API_KEY';

/* ─── Resend Email sender ─── */
async function sendEmail (toEmail, subject, htmlBody) {
  const body = JSON.stringify({
    from: CONFIG.EMAIL_FROM,
    to: [toEmail],
    subject,
    html: htmlBody,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type'  : 'application/json',
        'Authorization' : `Bearer ${CONFIG.RESEND_KEY}`,
        'Content-Length' : Buffer.byteLength(body),
      },
    }, res => {
      let buf = '';
      res.on('data', d => (buf += d));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildEmailHTML (type, entry, url, extra) {
  const min = CONFIG.AUTO_CANCEL_MIN;
  const biz = CONFIG.BUSINESS_PHONE;
  const btnStyle = 'display:inline-block;padding:16px 40px;background:#b8935a;color:#1e1208;text-decoration:none;border-radius:8px;font-family:sans-serif;font-size:16px;font-weight:600;letter-spacing:1px;';

  const templates = {
    join: {
      subject: `[PINE&CO] Waiting #${entry.number} confirmed`,
      body: `
        <p>파인앤코에 방문해주셔서 감사합니다.<br>Thank you for visiting Pine & Co.</p>
        <p style="font-size:48px;color:#b8935a;font-weight:300;margin:20px 0;">#${entry.number}</p>
        <p>웨이팅 ${entry.number}번 (${entry.partySize||2}명) 등록되었습니다.<br>
        You are #${entry.number} (${entry.partySize||2} guests).</p>
        <p>현재 대기: ${extra.myPos||1} / ${extra.total||1}</p>
        <p style="margin:24px 0;"><a href="${url}" style="${btnStyle}">CHECK MY STATUS</a></p>
        <p style="color:#999;">자리가 나면 문자/이메일로 알려드리겠습니다.<br>We'll notify you when your table is ready.</p>`,
    },
    call: {
      subject: `[PINE&CO] Your table is ready!`,
      body: `
        <p style="font-size:24px;color:#b8935a;font-weight:500;">자리가 마련되었습니다!<br>Your table is ready!</p>
        <p>${entry.name}님, ${min}분 내로 방문 부탁드리겠습니다.<br>
        ${entry.name}, we kindly ask you to arrive within ${min} minutes.</p>
        <p style="margin:24px 0;"><a href="${url}" style="${btnStyle}">VIEW DETAILS</a></p>
        <p>시간이 더 필요하시면 편하게 연락 부탁드립니다.<br>Need more time? Please don't hesitate to call us.</p>
        <p style="color:#b8935a;font-size:18px;margin-top:16px;">Tel: ${biz}</p>`,
    },
    cancel: {
      subject: `[PINE&CO] Waiting cancelled`,
      body: `
        <p>${entry.name}님, ${min}분이 경과하여 웨이팅이 자동 취소되었습니다.<br>
        ${entry.name}, your spot has been released after ${min} minutes.</p>
        <p>다시 방문해 주시면 재등록 가능합니다.<br>You're welcome to register again.</p>
        <p style="color:#b8935a;font-size:18px;margin-top:16px;">Tel: ${biz}</p>`,
    },
  };

  const t = templates[type];
  return {
    subject: t.subject,
    html: `<div style="max-width:480px;margin:0 auto;background:#1e1208;color:#f0ebe0;padding:40px 32px;font-family:'Georgia',serif;text-align:center;border-radius:12px;">
      <div style="font-size:14px;letter-spacing:4px;color:#b8935a;margin-bottom:24px;">PINE & CO SEOUL</div>
      ${t.body}
      <hr style="border:none;border-top:1px solid rgba(184,147,90,.2);margin:32px 0 16px;"/>
      <p style="font-size:11px;color:#7a6550;">Pine & Co Seoul</p>
    </div>`,
  };
}

// Normalize Korean phone to domestic format: 01012345678
function toKoreanDomestic (phone) {
  let clean = phone.replace(/[-\s()]/g, '');
  // Remove +82 or 82 prefix
  clean = clean.replace(/^\+?82/, '');
  // Add back leading 0 if missing
  if (!clean.startsWith('0')) clean = '0' + clean;
  return clean;
}

/* ─── Notification: auto-routes Korean → Aligo, International → Twilio ─── */
async function sendMessage (entry, type, extra = {}) {
  const rawPhone = entry.phone.replace(/-/g, '');
  const url   = `${CONFIG.PUBLIC_URL}/t/${entry.id}`;
  const min   = CONFIG.AUTO_CANCEL_MIN;
  const biz   = CONFIG.BUSINESS_PHONE;

  const messages = {
    join: {
      tpl  : CONFIG.TPL_JOIN,
      vars : { '#{이름}': entry.name, '#{번호}': String(entry.number),
               '#{순서}': String(extra.myPos||1), '#{전체대기}': String(extra.total||1),
               '#{링크}': url },
      sms  : `[PINE&CO]\n`
           + `파인앤코에 방문해주셔서 감사합니다.\n`
           + `웨이팅 ${entry.number}번 (${entry.partySize||2}명) 등록되었습니다.\n`
           + `자리가 나면 문자로 알려드리겠습니다.\n`
           + `\n`
           + `Thank you for visiting Pine & Co.\n`
           + `You are #${entry.number} (${entry.partySize||2} guests).\n`
           + `We'll notify you when your table is ready.\n`
           + `\n`
           + `대기: ${extra.myPos||1} / ${extra.total||1}\n`
           + `\n`
           + `${url}\n`
           + `\n`
           + `Tel: ${biz}`,
    },
    call: {
      tpl  : CONFIG.TPL_CALL,
      vars : { '#{이름}': entry.name, '#{번호}': String(entry.number), '#{분}': String(min), '#{링크}': url },
      sms  : `[PINE&CO]\n`
           + `${entry.name}님, 자리가 마련되었습니다!\n`
           + `5분 내로 방문 부탁드리겠습니다.\n`
           + `시간이 더 필요하시면 편하게 연락 부탁드립니다.\n`
           + `\n`
           + `${entry.name}, your table is ready!\n`
           + `We kindly ask you to arrive within 5 minutes.\n`
           + `Need more time? Please don't hesitate to call us.\n`
           + `\n`
           + `${url}\n`
           + `\n`
           + `Tel: ${biz}`,
    },
    cancel: {
      tpl  : CONFIG.TPL_CANCEL,
      vars : { '#{이름}': entry.name, '#{분}': String(min) },
      sms  : `[PINE&CO]\n`
           + `${entry.name}님, ${min}분이 경과하여 웨이팅이 자동 취소되었습니다.\n`
           + `다시 방문해 주시면 재등록 가능합니다.\n`
           + `\n`
           + `${entry.name}, your spot has been released after ${min} minutes.\n`
           + `You're welcome to register again.\n`
           + `\n`
           + `Tel: ${biz}`,
    },
  };

  const m = messages[type];
  const korean = isKoreanNumber(entry.phone);
  const label  = { join:'REGISTER', call:'NOTIFY', cancel:'AUTO-CANCEL' }[type];
  const krPhone = korean ? toKoreanDomestic(rawPhone) : rawPhone;

  // ═══════════════════════════════════════════════
  // EMAIL: always send if email provided (runs in parallel with SMS)
  // ═══════════════════════════════════════════════
  if (entry.email && IS_EMAIL_READY) {
    const emailData = buildEmailHTML(type, entry, url, extra);
    sendEmail(entry.email, emailData.subject, emailData.html)
      .then(r => {
        if (r?.id) console.log(`✅ Email sent (${type}) → ${entry.email}`);
        else console.error(`⚠️  Email response (${type}):`, JSON.stringify(r));
      })
      .catch(e => console.error('Email error:', e.message));
  }

  // ── Dev mode: console output ──
  if (IS_DEV && !IS_TWILIO_READY) {
    console.log(`\n🟡 [${label} simulation] ${korean ? 'KR' : 'INTL'}`);
    console.log(`   To: ${krPhone} (${entry.name})`);
    console.log(`   Msg: ${m.sms}\n`);
    return;
  }

  // ═══════════════════════════════════════════════
  // ROUTE 1: Korean number → Aligo (KakaoTalk + SMS)
  // ═══════════════════════════════════════════════
  if (korean) {
    if (IS_DEV) {
      console.log(`\n🟡 [${label} KR simulation] ${krPhone}`);
      console.log(`   ${m.sms}\n`);
      return;
    }

    // Try Alimtalk first
    const hasKakao = CONFIG.KAKAO_SENDER_KEY !== 'YOUR_SENDER_KEY'
                  && m.tpl !== `YOUR_TPL_CODE_${type.toUpperCase()}`;

    if (hasKakao) {
      let tplMsg = Object.entries(m.vars).reduce((s, [k, v]) => s.replaceAll(k, v), m.sms);
      try {
        const result = await httpPost('kakaoapi.aligo.in', '/akv10/alimtalk/send/', {
          apikey: CONFIG.ALIGO_KEY, userid: CONFIG.ALIGO_USER_ID,
          senderkey: CONFIG.KAKAO_SENDER_KEY, tpl_code: m.tpl,
          sender: CONFIG.ALIGO_SENDER, receiver_1: krPhone,
          recvname_1: entry.name, message_1: tplMsg,
          failover: 'Y', fsubject_1: 'PINE&CO Waiting',
          fmessage_1: m.sms, fmsg_type: 'LMS',
        });
        console.log(`✅ Alimtalk sent (${type}):`, result?.message || result?.result_code);
        return result;
      } catch (e) {
        console.error('Alimtalk error, falling back to SMS:', e.message);
      }
    }

    // Aligo SMS fallback
    try {
      const result = await httpPost('apis.aligo.in', '/send/', {
        key: CONFIG.ALIGO_KEY, user_id: CONFIG.ALIGO_USER_ID,
        sender: CONFIG.ALIGO_SENDER, receiver: krPhone,
        msg: m.sms, msg_type: 'LMS',
      });
      console.log(`✅ KR SMS sent (${type}):`, JSON.stringify(result));
      return result;
    } catch (e) {
      console.error('KR SMS error:', e.message);
    }
  }

  // ═══════════════════════════════════════════════
  // ROUTE 2: International number → Twilio
  // ═══════════════════════════════════════════════
  else {
    const e164 = toE164(entry.phone);

    if (!IS_TWILIO_READY) {
      console.log(`\n🟡 [${label} INTL simulation] → ${e164}`);
      console.log(`   ${m.sms}\n`);
      return;
    }

    try {
      const result = await sendTwilio(e164, m.sms);
      if (result?.sid) {
        console.log(`✅ Twilio sent (${type}) → ${e164}: SID ${result.sid}`);
      } else {
        console.error(`⚠️  Twilio response (${type}):`, JSON.stringify(result));
      }
      return result;
    } catch (e) {
      console.error('Twilio error:', e.message);
    }
  }
}

/* ─── Auto-cancel timer ─── */
function startCancelTimer (id) {
  if (cancelTimers[id]) clearTimeout(cancelTimers[id]);
  cancelTimers[id] = setTimeout(async () => {
    await withLock(async () => {
      const entry = queue.find(q => q.id === id);
      if (!entry || entry.status !== 'called') return;
      try { await sendMessage(entry, 'cancel'); } catch (e) { console.error(e); }
      queue = queue.filter(q => q.id !== id);
      delete cancelTimers[id];
      broadcast();
      console.log(`⏰ Auto-cancel (5 min): ${entry.name} (#${entry.number})`);
    });
  }, CONFIG.AUTO_CANCEL_MIN * 60 * 1000);
}

// ── Restart recovery: re-arm timers for entries that were "called" before crash ──
function recoverTimers () {
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

/* ═══════════════════════════════════════════════════════════
   API ROUTES
   ═══════════════════════════════════════════════════════════ */

// SSE real-time stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(queue)}\n\n`);
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// Public config
app.get('/api/config', (_req, res) => {
  res.json({
    businessName  : CONFIG.BUSINESS_NAME,
    businessEmoji : CONFIG.BUSINESS_EMOJI,
    autoCancelMin : CONFIG.AUTO_CANCEL_MIN,
    staffPin      : CONFIG.STAFF_PIN,
  });
});

// Queue read
app.get('/api/queue', (_req, res) => res.json(queue));

// ── Guest: join the waiting list ──
app.post('/api/queue/join', async (req, res) => {
  try {
    const result = await withLock(async () => {
      const { name, phone, partySize, email } = req.body;
      if (!name?.trim() || !phone?.trim())
        return { status: 400, body: { error: 'Please enter your name and phone number.' } };

      const cleanPhone = phone.trim().replace(/-/g, '');
      const size = Math.max(1, Math.min(20, parseInt(partySize) || 2));

      // Prevent duplicate: same phone still in queue
      const existing = queue.find(q => q.phone.replace(/-/g, '') === cleanPhone);
      if (existing)
        return { status: 409, body: { error: 'This phone number is already in the waiting list.', existing } };

      const entry = {
        id: uid(), number: nextNumber(),
        name: name.trim(), phone: phone.trim(),
        email: email?.trim() || null,
        partySize: size,
        joinedAt: Date.now(), status: 'waiting',
      };
      queue.push(entry);
      broadcast();

      const waitingList = queue.filter(q => q.status === 'waiting');
      const myPos = waitingList.findIndex(q => q.id === entry.id) + 1;

      // Send notification async — don't block response
      sendMessage(entry, 'join', { myPos, total: waitingList.length }).catch(console.error);

      return { status: 200, body: entry };
    });

    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('JOIN error:', e);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── Staff: notify guest (table ready) ──
app.post('/api/queue/call/:id', async (req, res) => {
  try {
    const result = await withLock(async () => {
      const entry = queue.find(q => q.id === req.params.id);
      if (!entry) return { status: 404, body: { error: 'Entry not found' } };
      if (entry.status === 'called') return { status: 200, body: { ok: true, note: 'Already notified' } };

      entry.status   = 'called';
      entry.calledAt = Date.now();
      broadcast();

      sendMessage(entry, 'call').catch(console.error);
      startCancelTimer(entry.id);  // 10-min timer starts NOW

      return { status: 200, body: { ok: true } };
    });
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('CALL error:', e);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Guest: can't come (cancel immediately) ──
app.post('/api/queue/decline/:id', async (req, res) => {
  try {
    await withLock(async () => {
      const entry = queue.find(q => q.id === req.params.id);
      if (!entry) return;
      if (cancelTimers[entry.id]) { clearTimeout(cancelTimers[entry.id]); delete cancelTimers[entry.id]; }
      console.log(`❌ Guest declined: ${entry.name} (#${entry.number})`);
      queue = queue.filter(q => q.id !== entry.id);
      broadcast();
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DECLINE error:', e);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Staff: guest checked in (seated) ──
app.post('/api/queue/done/:id', async (req, res) => {
  try {
    await withLock(async () => {
      if (cancelTimers[req.params.id]) { clearTimeout(cancelTimers[req.params.id]); delete cancelTimers[req.params.id]; }
      queue = queue.filter(q => q.id !== req.params.id);
      broadcast();
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DONE error:', e);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Staff: undo notification (back to waiting) ──
app.post('/api/queue/undo/:id', async (req, res) => {
  try {
    await withLock(async () => {
      if (cancelTimers[req.params.id]) { clearTimeout(cancelTimers[req.params.id]); delete cancelTimers[req.params.id]; }
      const entry = queue.find(q => q.id === req.params.id);
      if (entry) { entry.status = 'waiting'; delete entry.calledAt; }
      broadcast();
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('UNDO error:', e);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Staff/Guest: remove from queue ──
app.delete('/api/queue/:id', async (req, res) => {
  try {
    await withLock(async () => {
      if (cancelTimers[req.params.id]) { clearTimeout(cancelTimers[req.params.id]); delete cancelTimers[req.params.id]; }
      queue = queue.filter(q => q.id !== req.params.id);
      broadcast();
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE error:', e);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ─── Start ─── */
app.listen(CONFIG.PORT, () => {
  recoverTimers();
  const kakaoReady = CONFIG.KAKAO_SENDER_KEY !== 'YOUR_SENDER_KEY';
  console.log(`\n${CONFIG.BUSINESS_EMOJI}  ${CONFIG.BUSINESS_NAME} Waiting System started`);
  console.log(`   Guest page   : ${CONFIG.PUBLIC_URL}/customer.html`);
  console.log(`   Staff page   : ${CONFIG.PUBLIC_URL}/staff.html`);
  console.log(`   Korean SMS   : ${IS_DEV ? '🟡 Simulation' : '✅ Aligo live'}`);
  console.log(`   Alimtalk     : ${kakaoReady ? '✅ Connected' : '⚠️  Not configured'}`);
  console.log(`   Intl SMS     : ${IS_TWILIO_READY ? '✅ Twilio live' : '🟡 Simulation'}`);
  console.log(`   Email        : ${IS_EMAIL_READY ? '✅ Resend live' : '🟡 Not configured'}`);
  console.log(`   Auto-cancel  : ${CONFIG.AUTO_CANCEL_MIN} min`);
  console.log(`   Queue loaded : ${queue.length} entries\n`);
});

/*
╔══════════════════════════════════════════════════════════════╗
║        📋 Aligo Alimtalk Template Registration              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  ① Registration (TPL_JOIN)                                   ║
║  ─────────────────────────────                               ║
║  Hi #{이름}! 😊                                               ║
║  You are ##{번호} on the PINE&CO waiting list.               ║
║                                                              ║
║  Position: #{순서} of #{전체대기} parties                     ║
║                                                              ║
║  Track your status:                                          ║
║  #{링크}                                                     ║
║                                                              ║
║  ② Table ready (TPL_CALL)                                    ║
║  ─────────────────────────────                               ║
║  #{이름}, your table is ready! 🎉                             ║
║                                                              ║
║  Waiting ##{번호}                                             ║
║  Please arrive within #{분} minutes.                         ║
║                                                              ║
║  #{링크}                                                     ║
║                                                              ║
║  ③ Auto-cancel (TPL_CANCEL)                                  ║
║  ─────────────────────────────                               ║
║  #{이름}, your spot has been released                         ║
║  after #{분} minutes.                                        ║
║                                                              ║
║  You're welcome to register again! 🙏                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
*/
