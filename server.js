require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const Database = require('better-sqlite3');
const path = require('path');
const fsAsync = require('fs').promises;
const fsSync = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.error('[STARTUP] ADVERTENCIA: API_TOKEN no está en .env — todas las peticiones autenticadas serán rechazadas');
}

function authMiddleware(req, res, next) {
  if (req.path === '/webhook' || req.path === '/health' || req.path === '/stream') return next();
  const token = req.headers['x-api-token'] || req.query.token;
  if (!API_TOKEN || token !== API_TOKEN) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.use((req, res, next) => {
  const allowedOrigins = ['https://pendienteia.vercel.app', 'http://localhost:3000'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Peticiones sin origin (WAHA, curl, etc.)
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(authMiddleware);

// ─── SQLITE ───────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'tasks.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact TEXT NOT NULL,
    preview TEXT,
    key_message TEXT,
    task TEXT,
    priority TEXT DEFAULT 'hoy',
    urgent INTEGER DEFAULT 0,
    category TEXT DEFAULT 'personal',
    type TEXT DEFAULT 'pendiente',
    from_me INTEGER DEFAULT 0,
    meeting_date TEXT,
    meeting_time TEXT,
    meeting_location TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS conv_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact TEXT NOT NULL,
    text TEXT NOT NULL,
    from_me INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_conv_contact ON conv_history(contact, created_at);
  CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_type ON tasks(type);
  CREATE INDEX IF NOT EXISTS idx_priority ON tasks(priority);
`);

// Migraciones seguras
const cols = db.pragma('table_info(tasks)').map(c => c.name);
if (!cols.includes('type'))        db.exec("ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'pendiente'");
if (!cols.includes('from_me'))     db.exec("ALTER TABLE tasks ADD COLUMN from_me INTEGER DEFAULT 0");
if (!cols.includes('actions'))     db.exec("ALTER TABLE tasks ADD COLUMN actions TEXT");
if (!cols.includes('phone'))       db.exec("ALTER TABLE tasks ADD COLUMN phone TEXT");
if (!cols.includes('key_message')) db.exec("ALTER TABLE tasks ADD COLUMN key_message TEXT");
db.prepare("UPDATE tasks SET task='Revisar mensaje' WHERE task IS NULL OR task=''").run();

function cleanOldData() {
  db.prepare("DELETE FROM tasks WHERE status='resolved' AND resolved_at < datetime('now','-30 days')").run();
  db.prepare("DELETE FROM conv_history WHERE created_at < datetime('now','-1 day')").run();
}
cleanOldData();

// Programar limpieza diaria a las 3am
const n3 = new Date(); n3.setHours(3, 0, 0, 0);
if (n3 <= new Date()) n3.setDate(n3.getDate() + 1);
setTimeout(() => { cleanOldData(); setInterval(cleanOldData, 86400000); }, Math.max(0, n3 - new Date()));

function consolidateDuplicates() {
  const dups = db.prepare(`
    SELECT contact, COUNT(*) as n FROM tasks
    WHERE status='pending' AND type='pendiente'
    GROUP BY contact HAVING n > 1
  `).all();
  for (const d of dups) {
    const keep = db.prepare(`
      SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='pendiente'
      ORDER BY created_at DESC LIMIT 1
    `).get(d.contact);
    if (keep) {
      const r = db.prepare(`
        UPDATE tasks SET status='resolved', resolved_at=CURRENT_TIMESTAMP
        WHERE contact=? AND status='pending' AND type='pendiente' AND id != ?
      `).run(d.contact, keep.id);
      if (r.changes) console.log('[CONSOLIDATE] ' + d.contact + ': ' + r.changes + ' duplicados resueltos');
    }
  }
}
consolidateDuplicates();

// ─── EXTRACCIÓN DE ACCIONES ────────────────────────────────────────────────────
function extractActions(messages) {
  const text = messages.map(m => m.text || '').join(' ');
  const actions = [];
  const seen = new Set();

  // Teléfonos AR
  const phoneRegex = /(?:\+?54)?\s?9?\s?(?:11|2\d{2}|3\d{2})[\s\-]?\d{3,4}[\s\-]?\d{4}/g;
  for (const p of (text.match(phoneRegex) || [])) {
    const clean = p.replace(/[^0-9+]/g, '');
    if (clean.length >= 10 && !seen.has('phone:' + clean)) {
      seen.add('phone:' + clean);
      let normalized = clean;
      if (!normalized.startsWith('+')) {
        if (normalized.startsWith('54')) normalized = '+' + normalized;
        else if (normalized.startsWith('9')) normalized = '+54' + normalized;
        else normalized = '+549' + normalized;
      }
      actions.push({ type: 'phone', value: normalized, label: p.trim() });
    }
  }

  // Emails
  for (const e of (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])) {
    if (!seen.has('email:' + e)) { seen.add('email:' + e); actions.push({ type: 'email', value: e, label: e }); }
  }

  // CBU: 22 dígitos
  for (const c of (text.match(/\b\d{22}\b/g) || [])) {
    if (!seen.has('cbu:' + c)) {
      seen.add('cbu:' + c);
      actions.push({ type: 'cbu', value: c, label: 'CBU: ' + c.slice(0, 4) + '...' + c.slice(-4) });
    }
  }

  // Alias bancario
  for (const a of (text.match(/\b[a-zA-Z0-9]+\.[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\b/g) || [])) {
    if (a.length < 6 || a.length > 20 || a.includes('@')) continue;
    if (/\.(com|ar|net|org|io|co|app|gov|edu)$/i.test(a)) continue;
    const ctx = text.toLowerCase();
    const idx = ctx.indexOf(a.toLowerCase());
    const around = ctx.slice(Math.max(0, idx - 30), idx + a.length + 30);
    if (!/alias|cbu|transferencia|cuenta|cvu|mercadop|pago/i.test(around)) continue;
    if (!seen.has('alias:' + a)) {
      seen.add('alias:' + a);
      actions.push({ type: 'alias', value: a, label: 'Alias: ' + a });
    }
  }

  // Direcciones
  for (const a of (text.match(/(?:Av(?:enida)?\.?|Calle|Ruta)\s+[\w\s]+\d+(?:[,\s]+[\w\s]+)?/gi) || [])) {
    if (a.length >= 8 && a.length <= 100 && !seen.has('addr:' + a)) {
      seen.add('addr:' + a);
      actions.push({ type: 'address', value: a.trim(), label: a.trim().slice(0, 40) });
    }
  }

  return actions;
}

// ─── GROQ ─────────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── AUDIO (Whisper) ──────────────────────────────────────────────────────────
async function transcribeAudio(mediaUrl, mimetype) {
  try {
    const WAHA_API_KEY = process.env.WAHA_API_KEY;
    if (!WAHA_API_KEY) { console.error('[AUDIO] WAHA_API_KEY no configurado'); return null; }

    const audioRes = await fetch(mediaUrl, { headers: { 'X-Api-Key': WAHA_API_KEY } });
    if (!audioRes.ok) { console.error('[AUDIO] Error descargando:', audioRes.status); return null; }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    if (audioBuffer.length > 25 * 1024 * 1024) { console.error('[AUDIO] Archivo muy grande'); return null; }

    const os = require('os');
    const tmpPath = path.join(os.tmpdir(), 'pai-audio-' + Date.now() + '.ogg');
    // writeFile async — no bloquea el event loop
    await fsAsync.writeFile(tmpPath, audioBuffer);

    try {
      const transcription = await groq.audio.transcriptions.create({
        file: fsSync.createReadStream(tmpPath),
        model: 'whisper-large-v3-turbo',
        language: 'es',
        response_format: 'json',
      });
      const text = transcription.text?.trim() || '';
      console.log('[AUDIO] Transcrito (' + text.length + ' chars): ' + text.slice(0, 80));
      return text;
    } finally {
      fsAsync.unlink(tmpPath).catch(() => {});
    }
  } catch(e) {
    console.error('[AUDIO] Error:', e.message);
    return null;
  }
}

// ─── COLA ─────────────────────────────────────────────────────────────────────
let queue = [], processing = false;
async function enqueue(job) { queue.push(job); if (!processing) processQueue(); }
async function processQueue() {
  if (!queue.length) { processing = false; return; }
  processing = true;
  const job = queue.shift();
  try { await job(); } catch(e) { console.error('Queue error:', e.message); }
  setTimeout(processQueue, 2000);
}

// ─── HISTORIAL ────────────────────────────────────────────────────────────────
function saveToHistory(contact, text, fromMe) {
  db.prepare("INSERT INTO conv_history (contact, text, from_me) VALUES (?,?,?)").run(contact, text, fromMe ? 1 : 0);
}
function getRecentHistory(contact) {
  return db.prepare(`
    SELECT text, from_me FROM conv_history
    WHERE contact=? AND created_at > datetime('now','-6 hours')
    ORDER BY created_at ASC LIMIT 20
  `).all(contact).map(r => ({ text: r.text, fromMe: r.from_me === 1 }));
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
const SSE_MAX_CLIENTS = 20;
let sseClients = [];

function sseBroadcast(eventType, data) {
  const payload = 'event: ' + eventType + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
  sseClients = sseClients.filter(client => {
    try { client.write(payload); return true; }
    catch(e) { return false; }
  });
}

// Heartbeat cada 30s para mantener vivas las conexiones (iOS cierra inactivas)
setInterval(() => {
  sseClients = sseClients.filter(client => {
    try { client.write(': heartbeat\n\n'); return true; }
    catch(e) { return false; }
  });
}, 30000);

// ─── ANÁLISIS ─────────────────────────────────────────────────────────────────
async function analyzeWithRetry(contact, history, attempt = 0) {
  try {
    return await analyzeConversation(contact, history);
  } catch(e) {
    const retriable = e.status === 429 || (e.status >= 500 && e.status < 600) || e.code === 'ECONNRESET';
    if (retriable && attempt < 2) {
      const wait = (attempt + 1) * 4000;
      console.log('[GROQ-RETRY] ' + contact + ' intento ' + (attempt + 1) + ' en ' + wait + 'ms — ' + e.message);
      await new Promise(r => setTimeout(r, wait));
      return analyzeWithRetry(contact, history, attempt + 1);
    }
    throw e;
  }
}

async function analyzeConversation(contact, messages) {
  const now = new Date();
  const timeStr = now.toLocaleString('es-AR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const conv = messages.map((m, i) => (i + 1) + '. [' + (m.fromMe ? 'BRANDON' : contact) + ']: ' + m.text).join('\n');
  const lastIsFromOther = messages.length > 0 && !messages[messages.length - 1].fromMe;

  const res = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    temperature: 0,
    messages: [{
      role: 'user',
      content: `Sos el asistente personal de Brandon. Analizá esta conversación de WhatsApp y decidí si hay algo pendiente.
Hora actual: ${timeStr}
Contacto: ${contact}
Último mensaje sin respuesta de Brandon: ${lastIsFromOther ? 'SÍ' : 'NO'}

CONVERSACIÓN:
${conv}

CLASIFICACIÓN (elegí UNA):

needsAction:false — charla sin nada concreto pendiente
  Ej: "jajaja", "ok gracias", "cómo estás?", "buenas"

needsAction:true, type:"pendiente" — el contacto le pide algo concreto a Brandon
  Ej: "podés mandarme el presupuesto?", "necesito el dato de...", "cuándo me avisás?"

needsAction:true, type:"mio" — hay un plan acordado O Brandon asumió un compromiso
  Ej: "nos vemos mañana las 10", "quedamos el jueves a las 3", "dale nos juntamos",
      "te llamo yo", "yo me encargo", "ya lo arreglo", "mañana te mando"

PRIORIDAD (solo si needsAction:true):
- "ahora": urgente hoy, tiene hora específica hoy ("a las 3", "ya", "urgente")
- "hoy": acción para hoy o mañana sin hora específica
- "semana": plan para esta semana o la próxima

CATEGORÍA:
- "trabajo": clientes, proveedores, logística, finanzas, aduana, obra — o cualquier tema laboral
- "personal": amigos, familia, pareja, planes sociales

MEETING: si hay fecha/hora/lugar concreto, completalo. Usá formato legible ("mañana", "jueves", "10:00").

Respondé SOLO con JSON válido, sin texto extra:
{
  "needsAction": true,
  "type": "pendiente|mio",
  "priority": "ahora|hoy|semana",
  "category": "trabajo|personal",
  "keyMessage": "frase clave del mensaje (máx 70 chars)",
  "task": "qué tiene que hacer Brandon (máx 8 palabras)",
  "meeting": { "date": "fecha", "time": "hora", "location": "lugar" },
  "urgent": false
}`
    }],
    max_tokens: 500,
  });

  try {
    const content = res.choices[0].message.content.trim();
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { needsAction: false };
    const parsed = JSON.parse(match[0]);
    if (!parsed.needsAction || parsed.priority === 'ignorar') return { needsAction: false };
    return parsed;
  } catch(e) {
    return { needsAction: false };
  }
}

function saveTask(contact, msgs, analysis, contactPhone) {
  if (!analysis.needsAction || analysis.priority === 'ignorar') return;

  const extractedActions = extractActions(msgs);
  const meeting = (analysis.meeting?.date || analysis.meeting?.time) ? analysis.meeting : null;

  // Chip de calendario: siempre presente; si la IA detectó reunión se pre-rellena fecha/hora
  if (!extractedActions.some(a => a.type === 'calendar')) {
    extractedActions.push({
      type: 'calendar',
      title: (analysis.task || '').slice(0, 60),
      date: meeting ? (meeting.date || null) : null,
      time: meeting ? (meeting.time || null) : null,
      location: meeting ? (meeting.location || null) : null,
    });
  }

  // WhatsApp: siempre usar el número del contacto de WAHA (payload.from), no el del texto
  for (let i = extractedActions.length - 1; i >= 0; i--) {
    if (extractedActions[i].type === 'whatsapp') extractedActions.splice(i, 1);
  }
  if (contactPhone && !extractedActions.some(a => a.type === 'whatsapp_contact')) {
    extractedActions.unshift({ type: 'whatsapp_contact', value: contactPhone.replace(/\D/g, ''), label: 'WhatsApp' });
  }

  const actionsJson = extractedActions.length ? JSON.stringify(extractedActions) : null;

  // Filtro de alucinación: solo aplica si NO hay meeting detectado (las reuniones ya son validadas por la IA)
  // Incluye el nombre del contacto en el espacio de búsqueda, y requiere 2+ palabras ausentes para bloquear
  if (!meeting) {
    const allText = (msgs || []).map(m => (m.text || '').toLowerCase()).join(' ') + ' ' + contact.toLowerCase();
    const generic = new Set(['responder','revisar','enviar','mandar','contactar','confirmar','llamar',
      'consultar','preguntar','contestar','escribir','seguir','hacer','tarea','mensaje','sobre',
      'para','cosa','algo','tema','reunir','reunion','asistir','recibir','verse','juntarse','hablar']);
    const meaningfulWords = (analysis.task || '').toLowerCase().split(/\s+/)
      .filter(w => w.length >= 4 && !generic.has(w));
    if (meaningfulWords.length >= 2 && !meaningfulWords.some(w => allText.includes(w))) {
      console.log('[SKIP-HALLUCINATION] ' + contact + ': "' + analysis.task + '" no matchea');
      return;
    }
  }

  const type = analysis.type || 'pendiente';
  const lastMsg = msgs[msgs.length - 1]?.text || '';
  const keyMsg = (analysis.keyMessage || lastMsg).slice(0, 150);
  const safeTask = (analysis.task || 'Revisar mensaje').slice(0, 100);

  if (type === 'mio') {
    const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='mio' LIMIT 1").get(contact);
    if (existing) {
      db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,category=?,
        meeting_date=?,meeting_time=?,meeting_location=?,actions=?,phone=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(lastMsg.slice(0, 80), keyMsg, safeTask, analysis.priority || 'hoy',
          analysis.urgent ? 1 : 0, analysis.category || 'personal',
          meeting?.date || null, meeting?.time || null, meeting?.location || null,
          actionsJson, contactPhone, existing.id);
      console.log('[MIO-UPDATE] ' + contact + ': ' + safeTask);
      sseBroadcast('task_changed', { type: 'updated', taskType: 'mio', contact });
      return;
    }
  } else {
    const recentList = db.prepare(`
      SELECT id, task FROM tasks
      WHERE contact=? AND status='pending' AND type='pendiente'
      AND created_at > datetime('now', '-2 hours')
      ORDER BY created_at DESC LIMIT 5
    `).all(contact);

    const genericSet = new Set(['responder','revisar','enviar','mandar','contactar','confirmar','llamar','consultar','preguntar','contestar','escribir','seguir','hacer','tarea','mensaje','para','sobre','cosa','algo','tema','obtener','recibir']);
    const newWords = safeTask.toLowerCase().split(/\s+/).filter(w => w.length >= 4 && !genericSet.has(w));
    let matchedExisting = null;
    for (const r of recentList) {
      const oldWords = (r.task || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4 && !genericSet.has(w));
      if (newWords.some(w => oldWords.some(o => o.includes(w) || w.includes(o)))) { matchedExisting = r; break; }
    }

    if (matchedExisting) {
      db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,category=?,
        meeting_date=?,meeting_time=?,meeting_location=?,actions=?,phone=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(lastMsg.slice(0, 80), keyMsg, safeTask, analysis.priority || 'hoy',
          analysis.urgent ? 1 : 0, analysis.category || 'personal',
          meeting?.date || null, meeting?.time || null, meeting?.location || null,
          actionsJson, contactPhone, matchedExisting.id);
      console.log('[PENDIENTE-UPDATE] ' + contact + ': ' + safeTask);
      sseBroadcast('task_changed', { type: 'updated', taskType: 'pendiente', contact });
      return;
    }
  }

  // Fix: el INSERT original no incluía actions ni phone — datos se perdían en nuevas tareas
  db.prepare(`INSERT INTO tasks
    (contact,preview,key_message,task,priority,urgent,category,type,from_me,
     meeting_date,meeting_time,meeting_location,actions,phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(contact, lastMsg.slice(0, 80), keyMsg, safeTask, analysis.priority || 'hoy',
      analysis.urgent ? 1 : 0, analysis.category || 'personal', type, type === 'mio' ? 1 : 0,
      meeting?.date || null, meeting?.time || null, meeting?.location || null,
      actionsJson, contactPhone);
  console.log('[' + type.toUpperCase() + '-NEW][' + (analysis.priority || 'hoy') + '] ' + contact + ': ' + safeTask);
  sseBroadcast('task_changed', { type: 'new', taskType: type, contact });
}

let sinResponderPending = {};
function scheduleSinResponder(contact, msgs, analysis, contactPhone) {
  const lastMsg = msgs[msgs.length - 1]?.text || '';
  if (sinResponderPending[contact]?.timer) clearTimeout(sinResponderPending[contact].timer);
  sinResponderPending[contact] = {
    timer: setTimeout(() => {
      delete sinResponderPending[contact];
      const history = getRecentHistory(contact);
      const lastInHistory = history[history.length - 1];
      if (lastInHistory && lastInHistory.fromMe) return;
      const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='sin_responder' LIMIT 1").get(contact);
      if (!existing) {
        const phone = getCachedPhone(contact) || contactPhone || null;
        const srActions = [];
        if (phone) srActions.push({ type: 'whatsapp_contact', value: phone.replace(/\D/g, ''), label: 'WhatsApp' });
        srActions.push({ type: 'calendar', title: 'Responder a ' + contact, date: null, time: null, location: null });
        db.prepare("INSERT INTO tasks (contact,preview,key_message,task,priority,category,type,phone,actions) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(contact, lastMsg.slice(0, 80), (analysis.keyMessage || lastMsg).slice(0, 150),
            'Responder a ' + contact, 'hoy', analysis.category || 'personal', 'sin_responder', phone, JSON.stringify(srActions));
        console.log('[SIN_RESPONDER - 4h] ' + contact);
        sseBroadcast('task_changed', { type: 'new', taskType: 'sin_responder', contact });
      }
    }, 4 * 60 * 60 * 1000)
  };
}

// ─── RATE LIMIT (webhook) ─────────────────────────────────────────────────────
const _webhookRL = {};
const WEBHOOK_RPM = 120;
function webhookAllowed(ip) {
  const now = Date.now();
  if (!_webhookRL[ip] || now - _webhookRL[ip].ts > 60000) {
    _webhookRL[ip] = { count: 1, ts: now };
    return true;
  }
  return ++_webhookRL[ip].count <= WEBHOOK_RPM;
}
setInterval(() => {
  const old = Date.now() - 120000;
  for (const ip of Object.keys(_webhookRL)) if (_webhookRL[ip].ts < old) delete _webhookRL[ip];
}, 3600000);

// ─── BUFFERS ──────────────────────────────────────────────────────────────────
let burstBuffer = {};
const phoneCache = {};
const PHONE_CACHE_TTL = 24 * 60 * 60 * 1000;
function setCachedPhone(contact, phone) {
  phoneCache[contact] = { phone, ts: Date.now() };
}
function getCachedPhone(contact) {
  const e = phoneCache[contact];
  if (!e) return null;
  if (Date.now() - e.ts > PHONE_CACHE_TTL) { delete phoneCache[contact]; return null; }
  return e.phone;
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Auth: IPs internas (Docker + localhost) siempre permitidas; externas requieren WAHA_API_KEY
  const ip = req.ip || '';
  const isTrustedIP = ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:172.') || ip.startsWith('172.');
  const wahaKey = req.headers['x-api-key'];
  const expectedKey = process.env.WAHA_API_KEY;
  const keyOk = expectedKey && wahaKey === expectedKey;
  if (!isTrustedIP && !keyOk) {
    console.log('[WEBHOOK] Rechazado - auth fallida de', ip);
    return res.sendStatus(403);
  }

  if (!webhookAllowed(req.ip)) {
    console.log('[WEBHOOK] Rate limit para', req.ip);
    return res.status(429).json({ error: 'Rate limit excedido' });
  }

  res.sendStatus(200);

  try {
    const { event, payload } = req.body;
    if (event !== 'message') return;

    let text = payload.body || '';
    const contact = payload._data?.notifyName || payload.from || '';
    const fromMe = payload.fromMe || false;
    // Extraer número de teléfono del JID de WAHA — strip @server y cualquier no-dígito
    const rawFrom = (payload.from || '').replace(/@.*$/, '').replace(/\D/g, '');
    const contactPhoneNumber = rawFrom.length >= 7 ? rawFrom : null;
    const mediaType = payload._data?.type || payload.type || '';
    const mediaUrl = payload.media?.url || payload._data?.mediaUrl || null;
    const mimetype = payload.media?.mimetype || payload._data?.mimetype || '';

    if (contact === 'status@broadcast') return;
    if (!payload._data?.notifyName && contact.includes('@g.us')) return;

    const isAudio = mediaType === 'ptt' || mediaType === 'audio' || mimetype.startsWith('audio/');
    if (isAudio && mediaUrl) {
      console.log('[AUDIO] Detectado de ' + contact + ', transcribiendo...');
      const transcribed = await transcribeAudio(mediaUrl, mimetype);
      if (transcribed && transcribed.length >= 3) {
        text = '[🎤 audio] ' + transcribed;
      } else {
        return;
      }
    }

    if (!text || text.length < 3) return;

    saveToHistory(contact, text, fromMe);

    if (fromMe) {
      db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE contact=? AND type='sin_responder' AND status='pending'").run(contact);
      if (sinResponderPending[contact]?.timer) {
        clearTimeout(sinResponderPending[contact].timer);
        delete sinResponderPending[contact];
      }
    }

    if (!burstBuffer[contact]) burstBuffer[contact] = { timer: null, hasIncoming: false, firstTs: Date.now(), phone: null };
    if (burstBuffer[contact].timer) clearTimeout(burstBuffer[contact].timer);
    if (!fromMe) {
      burstBuffer[contact].hasIncoming = true;
      if (contactPhoneNumber) {
        burstBuffer[contact].phone = contactPhoneNumber;
        setCachedPhone(contact, contactPhoneNumber);
      }
    }

    const burstAge = Date.now() - burstBuffer[contact].firstTs;
    const burstDelay = burstAge > 90000 ? 500 : 20000;

    burstBuffer[contact].timer = setTimeout(() => {
      const { hasIncoming, phone } = burstBuffer[contact];
      delete burstBuffer[contact];
      if (!hasIncoming) return;
      enqueue(async () => {
        try {
          const history = getRecentHistory(contact);
          if (!history.length) return;
          const lastIsFromOther = !history[history.length - 1].fromMe;
          const analysis = await analyzeWithRetry(contact, history);
          console.log('[ANALYSIS] ' + contact + ': needsAction=' + analysis.needsAction + ' priority=' + analysis.priority + ' type=' + analysis.type + ' task="' + analysis.task + '"');
          if (analysis.needsAction) {
            saveTask(contact, history, analysis, phone || getCachedPhone(contact));
          }
          if (lastIsFromOther) scheduleSinResponder(contact, history, analysis, phone || getCachedPhone(contact));
        } catch(e) { console.error('Analysis error [' + contact + ']:', e.message); }
      });
    }, burstDelay);

  } catch(e) { console.error('Webhook error:', e.message); }
});

// ─── RUTAS API ────────────────────────────────────────────────────────────────
app.get('/tasks', (req, res) => {
  const type = req.query.type || 'pendiente';
  const tasks = db.prepare(`
    SELECT *, CAST((julianday('now')-julianday(created_at))*24 AS INTEGER) as hours
    FROM tasks WHERE status='pending' AND type=?
    ORDER BY CASE priority WHEN 'ahora' THEN 0 WHEN 'hoy' THEN 1 ELSE 2 END, created_at ASC
  `).all(type);
  const body = tasks.map(t => ({
    id: t.id, contact: t.contact,
    preview: t.key_message || t.preview,
    task: t.task, priority: t.priority,
    urgent: t.urgent === 1, category: t.category, type: t.type, fromMe: t.from_me === 1,
    meeting: t.meeting_date || t.meeting_time ? { date: t.meeting_date, time: t.meeting_time, location: t.meeting_location } : null,
    actions: t.actions ? (() => { try { return JSON.parse(t.actions); } catch(e) { return []; } })() : [],
    phone: t.phone || null,
    hours: t.hours || 0, createdAt: t.created_at,
  }));
  const etag = '"' + require('crypto').createHash('md5').update(JSON.stringify(body)).digest('hex').slice(0, 16) + '"';
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('ETag', etag).set('Cache-Control', 'no-cache').json(body);
});

// Validar que el :id sea un entero positivo
function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

app.delete('/tasks/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  sseBroadcast('task_changed', { type: 'resolved', id });
  res.sendStatus(200);
});

app.patch('/tasks/:id/snooze', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  db.prepare("UPDATE tasks SET priority='semana',urgent=0 WHERE id=?").run(id);
  sseBroadcast('task_changed', { type: 'snoozed', id });
  res.sendStatus(200);
});

app.patch('/tasks/:id/keep', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  db.prepare("UPDATE tasks SET type='pendiente' WHERE id=?").run(id);
  sseBroadcast('task_changed', { type: 'kept', id });
  res.sendStatus(200);
});

app.patch('/tasks/:id/edit', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const { task, priority } = req.body || {};
  if (!task || typeof task !== 'string') return res.status(400).json({ error: 'task required' });
  const trimmed = task.trim().slice(0, 200);
  if (trimmed.length < 2) return res.status(400).json({ error: 'task too short' });
  const validPrio = ['ahora', 'hoy', 'semana'].includes(priority) ? priority : null;
  if (validPrio) {
    db.prepare("UPDATE tasks SET task=?, priority=? WHERE id=?").run(trimmed, validPrio, id);
  } else {
    db.prepare("UPDATE tasks SET task=? WHERE id=?").run(trimmed, id);
  }
  sseBroadcast('task_changed', { type: 'edited', id });
  res.sendStatus(200);
});

app.post('/admin/reset', (req, res) => {
  const t1 = db.prepare("DELETE FROM tasks").run();
  const t2 = db.prepare("DELETE FROM conv_history").run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('tasks','conv_history')").run();
  console.log('[RESET] Base limpiada: ' + t1.changes + ' tareas, ' + t2.changes + ' mensajes de historial');
  sseBroadcast('task_changed', { type: 'reset' });
  res.json({ ok: true, deletedTasks: t1.changes, deletedHistory: t2.changes });
});

app.get('/health', (req, res) => {
  const tasks = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='pending'").get();
  const hist = db.prepare("SELECT COUNT(*) as n FROM conv_history").get();
  res.json({
    status: 'ok',
    pendingTasks: tasks.n,
    queueLength: queue.length,
    historyMsgs: hist.n,
    sseClients: sseClients.length,
  });
});

app.get('/stream', (req, res) => {
  const token = req.query.token || req.headers['x-api-token'];
  if (!API_TOKEN || token !== API_TOKEN) return res.status(401).end();
  if (sseClients.length >= SSE_MAX_CLIENTS) {
    console.log('[SSE] Límite de clientes alcanzado (' + SSE_MAX_CLIENTS + ')');
    return res.status(429).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  sseClients.push(res);
  console.log('[SSE] Cliente conectado. Total: ' + sseClients.length);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    console.log('[SSE] Cliente desconectado. Total: ' + sseClients.length);
  });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v5.7 en puerto', process.env.PORT || 3001));
