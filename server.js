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
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    contact TEXT,
    task TEXT,
    preview TEXT,
    reason TEXT, -- 'error' o 'done'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
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
if (!cols.includes('company'))     db.exec("ALTER TABLE tasks ADD COLUMN company TEXT");
if (!cols.includes('due_date'))    db.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
db.exec("CREATE TABLE IF NOT EXISTS contact_phones (contact TEXT PRIMARY KEY, phone TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS contact_company (contact TEXT PRIMARY KEY, company TEXT)");
db.prepare("UPDATE tasks SET task='Revisar mensaje' WHERE task IS NULL OR task=''").run();

// ─── EMPRESAS ───────────────────────────────────────────────────────────────
// Claves canónicas (lo que se guarda en DB). El front mapea a nombre y color.
const COMPANIES = ['financiera', 'serviwhite', 'tecnophos', 'adc', 'transtide', 'svn', 'personal'];
function validCompany(c) {
  if (!c) return null;
  const k = String(c).toLowerCase().trim();
  return COMPANIES.includes(k) ? k : null;
}
// Valida fecha ISO YYYY-MM-DD (la que produce la IA para vencimientos)
function validDate(d) {
  if (!d) return null;
  const s = String(d).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const dt = new Date(s + 'T00:00:00');
  return isNaN(dt.getTime()) ? null : s;
}
// Cache contacto→empresa (se aprende cuando Brandon asigna empresa a una tarea)
const companyCache = {};
function setCachedCompany(contact, company) {
  const c = validCompany(company);
  if (!c || !contact) return;
  companyCache[contact] = c;
  db.prepare("INSERT OR REPLACE INTO contact_company (contact, company) VALUES (?,?)").run(contact, c);
}
function getCachedCompany(contact) {
  if (!contact) return null;
  if (companyCache[contact]) return companyCache[contact];
  const row = db.prepare("SELECT company FROM contact_company WHERE contact=?").get(contact);
  if (row?.company) { companyCache[contact] = row.company; return row.company; }
  return null;
}

function cleanOldData() {
  db.prepare("DELETE FROM tasks WHERE status='resolved' AND resolved_at < datetime('now','-30 days')").run();
  db.prepare("DELETE FROM conv_history WHERE created_at < datetime('now','-1 day')").run();
}
cleanOldData();

// Escalado por vencimiento: las tareas con due_date suben de prioridad al acercarse,
// y quedan urgentes si están vencidas o vencen hoy/mañana.
function escalateDueDates() {
  let changes = 0;
  // Vencidas o que vencen hoy/mañana → urgente
  changes += db.prepare(`UPDATE tasks SET priority='ahora', urgent=1
    WHERE status='pending' AND due_date IS NOT NULL
    AND due_date <= date('now','localtime','+1 day')
    AND NOT (priority='ahora' AND urgent=1)`).run().changes;
  // Vencen dentro de 3 días → al menos "hoy"
  changes += db.prepare(`UPDATE tasks SET priority='hoy'
    WHERE status='pending' AND due_date IS NOT NULL
    AND due_date <= date('now','localtime','+3 days')
    AND priority='semana'`).run().changes;
  if (changes) {
    console.log('[ESCALATE] ' + changes + ' tareas escaladas por vencimiento');
    sseBroadcast('task_changed', { type: 'escalated' });
  }
}
escalateDueDates();
setInterval(escalateDueDates, 3 * 60 * 60 * 1000); // cada 3 horas

// Programar limpieza diaria a las 3am
const n3 = new Date(); n3.setHours(3, 0, 0, 0);
if (n3 <= new Date()) n3.setDate(n3.getDate() + 1);
setTimeout(() => { cleanOldData(); escalateDueDates(); setInterval(() => { cleanOldData(); escalateDueDates(); }, 86400000); }, Math.max(0, n3 - new Date()));

function consolidateDuplicates() {
  const dups = db.prepare(`
    SELECT contact, COUNT(*) as n FROM tasks
    WHERE status='pending' AND type='pendiente' AND contact != 'Yo'
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
// Mapea el mimetype del audio a una extensión que Groq/Whisper reconozca.
function audioExtFromMime(mimetype) {
  const m = (mimetype || '').toLowerCase();
  if (m.includes('webm')) return '.webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('wav')) return '.wav';
  return '.ogg';
}

// Transcribe un buffer de audio ya descargado. Devuelve el texto o null.
async function transcribeBuffer(audioBuffer, mimetype) {
  if (audioBuffer.length > 25 * 1024 * 1024) { console.error('[AUDIO] Archivo muy grande'); return null; }
  const os = require('os');
  const tmpPath = path.join(os.tmpdir(), 'pai-audio-' + Date.now() + audioExtFromMime(mimetype));
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
}

async function transcribeAudio(mediaUrl, mimetype) {
  try {
    const WAHA_API_KEY = process.env.WAHA_API_KEY;
    if (!WAHA_API_KEY) { console.error('[AUDIO] WAHA_API_KEY no configurado'); return null; }

    const audioRes = await fetch(mediaUrl, { headers: { 'X-Api-Key': WAHA_API_KEY } });
    if (!audioRes.ok) { console.error('[AUDIO] Error descargando:', audioRes.status); return null; }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    return await transcribeBuffer(audioBuffer, mimetype);
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
  const todayAR = now.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const conv = messages.map((m, i) => (i + 1) + '. [' + (m.fromMe ? 'BRANDON' : contact) + ']: ' + m.text).join('\n');
  const lastIsFromOther = messages.length > 0 && !messages[messages.length - 1].fromMe;

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0,
    messages: [{
      role: 'user',
      content: `Sos el asistente personal de Brandon. Tu trabajo es detectar SOLO tareas REALES Y CONCRETAS en conversaciones de WhatsApp. Sos extremadamente estricto — preferís no crear tarea antes que crear una falsa.

❌ NO crear tarea para: saludos, "ok dale", "jaja", "👍", "¿cómo estás?", preguntas vagas, comentarios, chismes, confirmaciones de recibo, conversaciones que no llegaron a un acuerdo.

✅ SÍ crear tarea solo si hay: pedido textual concreto ("mandame X", "cotizame Y", "necesito Z"), evento acordado con fecha/hora ("el lunes a las 8"), compromiso explícito de Brandon ("yo me encargo", "te llamo mañana"), o dato importante pedido (CBU, dirección).

EJEMPLOS de lo que NO es tarea: "¿cómo vas?" / "jaja sí re" / "ok cualquier cosa avisame" / "¿viste lo de ayer?" / "buenas tardes"
EJEMPLOS de lo que SÍ es tarea: "mandame el presupuesto" / "nos vemos el viernes a las 7" / "necesito el flete para el lunes"
Hora actual: ${timeStr}
Fecha de hoy (YYYY-MM-DD): ${todayAR}
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

EMPRESA (Brandon maneja 6 empresas — asigná UNA solo si el tema lo deja claro, sino null):
- "financiera": préstamos, créditos, cobranzas, finanzas
- "serviwhite": alquiler y venta de módulos / containers
- "tecnophos": tecnología, fosfatos/químicos, industria
- "adc": ADC
- "transtide": fletes, logística, freight, aduana, transporte de carga
- "svn": SVN Designs, diseño, branding, web
- "personal": no es de ninguna empresa (familia, amigos, trámites propios)
Si no podés deducir la empresa con seguridad, usá null (NO inventes).

MEETING: si hay fecha/hora/lugar concreto, completalo. Usá formato legible ("mañana", "jueves", "10:00").

DUEDATE (fecha límite): si hay un plazo o vencimiento concreto ("antes del viernes", "vence el 30", "para fin de mes", "el lunes"), calculá la fecha exacta en formato YYYY-MM-DD usando la fecha de hoy. Si no hay plazo claro, null.

Respondé SOLO con JSON válido, sin texto extra:
{
  "needsAction": true,
  "type": "pendiente|mio",
  "priority": "ahora|hoy|semana",
  "category": "trabajo|personal",
  "company": "financiera|serviwhite|tecnophos|adc|transtide|svn|personal|null",
  "keyMessage": "frase clave del mensaje (máx 70 chars)",
  "task": "qué tiene que hacer Brandon (máx 8 palabras)",
  "meeting": { "date": "fecha", "time": "hora", "location": "lugar" },
  "dueDate": "YYYY-MM-DD o null",
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
  // Empresa: el mapeo aprendido del contacto manda; sino la inferencia de la IA
  const company = getCachedCompany(contact) || validCompany(analysis.company) || null;
  const dueDate = validDate(analysis.dueDate);

  if (type === 'mio') {
    const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='mio' LIMIT 1").get(contact);
    if (existing) {
      db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,category=?,company=?,due_date=?,
        meeting_date=?,meeting_time=?,meeting_location=?,actions=?,phone=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(lastMsg.slice(0, 80), keyMsg, safeTask, analysis.priority || 'hoy',
          analysis.urgent ? 1 : 0, analysis.category || 'personal', company, dueDate,
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
      db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,category=?,company=?,due_date=?,
        meeting_date=?,meeting_time=?,meeting_location=?,actions=?,phone=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(lastMsg.slice(0, 80), keyMsg, safeTask, analysis.priority || 'hoy',
          analysis.urgent ? 1 : 0, analysis.category || 'personal', company, dueDate,
          meeting?.date || null, meeting?.time || null, meeting?.location || null,
          actionsJson, contactPhone, matchedExisting.id);
      console.log('[PENDIENTE-UPDATE] ' + contact + ': ' + safeTask);
      sseBroadcast('task_changed', { type: 'updated', taskType: 'pendiente', contact });
      return;
    }
  }

  // Fix: el INSERT original no incluía actions ni phone — datos se perdían en nuevas tareas
  db.prepare(`INSERT INTO tasks
    (contact,preview,key_message,task,priority,urgent,category,company,due_date,type,from_me,
     meeting_date,meeting_time,meeting_location,actions,phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(contact, lastMsg.slice(0, 80), keyMsg, safeTask, analysis.priority || 'hoy',
      analysis.urgent ? 1 : 0, analysis.category || 'personal', company, dueDate, type, type === 'mio' ? 1 : 0,
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
        db.prepare("INSERT INTO tasks (contact,preview,key_message,task,priority,category,company,type,phone,actions) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(contact, lastMsg.slice(0, 80), (analysis.keyMessage || lastMsg).slice(0, 150),
            'Responder a ' + contact, 'hoy', analysis.category || 'personal',
            getCachedCompany(contact) || validCompany(analysis.company) || null, 'sin_responder', phone, JSON.stringify(srActions));
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
  db.prepare("INSERT OR REPLACE INTO contact_phones (contact, phone) VALUES (?,?)").run(contact, phone);
}
function getCachedPhone(contact) {
  const e = phoneCache[contact];
  if (e) {
    if (Date.now() - e.ts > PHONE_CACHE_TTL) { delete phoneCache[contact]; }
    else return e.phone;
  }
  const row = db.prepare("SELECT phone FROM contact_phones WHERE contact=?").get(contact);
  if (row?.phone) { phoneCache[contact] = { phone: row.phone, ts: Date.now() }; return row.phone; }
  return null;
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

// ─── BOT: MENSAJES A MÍ MISMO ────────────────────────────────────────────────
const MY_WA_NUMBER = process.env.MY_WA_NUMBER || '17542365652@c.us';
const SERVWHITE_NUMBER = '61560420573356@lid';
// Detectar si un mensaje es del propio Brandon (self-chat o mensaje desde su número)
function isBrandonSelf(payload) {
  const from = payload.from || '';
  const to = payload.to || payload._data?.to || '';
  // Mensajes que Brandon se manda a sí mismo (self-chat de WhatsApp)
  if (from === to) return true;
  // Mensajes desde su número conocido
  if (from === MY_WA_NUMBER || to === MY_WA_NUMBER) return true;
  // Chat con sí mismo: from termina en su número
  if (from.includes('17542365652')) return true;
  return false;
}

async function sendWAMessage(to, text) {
  try {
    const WAHA_URL2 = process.env.WAHA_URL || 'http://localhost:3000';
    const WAHA_KEY2 = process.env.WAHA_API_KEY || 'pendiente2024';
    const WAHA_SES2 = process.env.WAHA_SESSION || 'default';
    await fetch(WAHA_URL2 + '/api/sendText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_KEY2 },
      body: JSON.stringify({ session: WAHA_SES2, chatId: to, text })
    });
    console.log('[BOT] -> ' + to + ': ' + text.slice(0,50));
  } catch(e) { console.error('[BOT] send error:', e.message); }
}

async function processBotCommand(text, fromId, companyHint) {
  const now = new Date();
  const timeStr = now.toLocaleString('es-AR', { weekday:'long', day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
  const todayAR = now.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const ROBOT = String.fromCodePoint(0x1F916);
  const CHECK = String.fromCodePoint(0x2705);
  const CROSS = String.fromCodePoint(0x274C);

  // Detecci\u00f3n de CONSULTA (mostrar pendientes). Estricta: solo frases que claramente
  // piden ver la lista, no tareas que casualmente contengan "tengo"/"tarea"/"pendiente".
  const isQuery = /^\s*(qu[e\u00e9]\s+(tengo|hay|tareas?|pendientes?|debo|me falta|ten[i\u00ed]a)|cu[a\u00e1]les|mis\s+(tareas?|pendientes?|compromisos?)|mostr(ame|arme|[a\u00e1])|ver\s+(mis|tareas?|pendientes?)|dame\s+(la\s+lista|mis))\b/i.test(text);
  if (isQuery) {
    const tasks = db.prepare("SELECT type, task, contact FROM tasks WHERE status=\'pending\' ORDER BY type, created_at ASC LIMIT 10").all();
    if (!tasks.length) {
      if (fromId) await sendWAMessage(fromId, ROBOT + ' No tens nada pendiente');
      return { query: true, count: 0 };
    }
    let msg = ROBOT + ' Tus pendientes:\n';
    tasks.forEach(function(t, i) {
      const c = (t.contact && t.contact !== 'Yo') ? ' (' + t.contact + ')' : '';
      msg += (i + 1) + '. ' + t.task + c + '\n';
    });
    if (fromId) await sendWAMessage(fromId, msg.trim());
    return { query: true, count: tasks.length };
  }

  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Sos el asistente de Brandon. El te manda este mensaje para anotar una tarea. Hora: ' + timeStr + '. Hoy es ' + todayAR + ' (YYYY-MM-DD). Brandon maneja 6 empresas: financiera (prestamos/creditos/finanzas), serviwhite (modulos/containers), tecnophos (tecnologia/quimica/industria), adc, transtide (fletes/logistica/freight/aduana), svn (SVN Designs/diseño/web). Si la tarea es de una empresa usa su clave, si es personal usa "personal", si no sabes usa null. Si hay una fecha limite/vencimiento, calcula dueDate exacto en YYYY-MM-DD desde la fecha de hoy, sino null. Mensaje: "' + text + '". Responde SOLO JSON: {"task":"descripcion max 10 palabras","type":"pendiente o mio","priority":"ahora hoy o semana","category":"trabajo o personal","company":"financiera|serviwhite|tecnophos|adc|transtide|svn|personal|null","dueDate":"YYYY-MM-DD o null","contact":null,"meeting":{"date":null,"time":null},"reply":"confirmacion max 10 palabras"}' }],
      max_tokens: 250,
    });
    const match = res.choices[0].message.content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json');
    const a = JSON.parse(match[0]);
    if (!a.task) throw new Error('no task');
    const meet = (a.meeting && (a.meeting.date || a.meeting.time)) ? a.meeting : null;
    db.prepare('INSERT INTO tasks (contact,preview,key_message,task,priority,urgent,category,company,due_date,type,from_me,meeting_date,meeting_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(a.contact || 'Yo', text.slice(0,80), text.slice(0,150), a.task, a.priority || 'hoy', 0, a.category || 'personal', validCompany(companyHint) || validCompany(a.company), validDate(a.dueDate), a.type || 'pendiente', 1, meet ? meet.date : null, meet ? meet.time : null);
    sseBroadcast('task_changed', { type: 'new', taskType: a.type });
    console.log('[BOT] Tarea creada: ' + a.task);
    if (fromId) await sendWAMessage(fromId, ROBOT + ' ' + CHECK + ' ' + (a.reply || 'Anotado: ' + a.task));
    return a;
  } catch(e) {
    console.error('[BOT] Error:', e.message);
    if (fromId) await sendWAMessage(fromId, ROBOT + ' ' + CROSS + ' No entendi, intenta de nuevo');
    throw e;
  }
}
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
    console.log('[DEBUG-IN] from=' + (payload.from||'?') + ' fromMe=' + fromMe + ' body=' + (payload.body||'').slice(0,40));

    // Extraer número de teléfono del JID de WAHA
    // @lid = Privacy ID de WhatsApp (no es un número real) — ignorar
    const jid = payload.from || '';
    const isLid = jid.endsWith('@lid');
    const rawFrom = isLid ? '' : jid.replace(/@.*$/, '').replace(/\D/g, '');
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

    // ── BOT: Si Brandon se manda mensajes a sí mismo (después de transcripción) ──
    if ((fromMe && isBrandonSelf(payload) || (payload.from || "").includes("61560420573356")) && text && text.length >= 3) {
      console.log('[BOT] Comando recibido: ' + text.slice(0,50));
      const selfId = payload.from || '';
      enqueue(async () => {
        try { await processBotCommand(text, selfId); } catch(e) { console.error('[BOT]', e.message); }
      });
      return;
    }

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
    urgent: t.urgent === 1, category: t.category, company: t.company || null, type: t.type, fromMe: t.from_me === 1,
    meeting: t.meeting_date || t.meeting_time ? { date: t.meeting_date, time: t.meeting_time, location: t.meeting_location } : null,
    actions: t.actions ? (() => { try { return JSON.parse(t.actions); } catch(e) { return []; } })() : [],
    phone: t.phone || null, dueDate: t.due_date || null,
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
  const body = req.body || {};
  const { task, priority, phone, company, dueDate } = body;
  if (!task || typeof task !== 'string') return res.status(400).json({ error: 'task required' });
  const trimmed = task.trim().slice(0, 200);
  if (trimmed.length < 2) return res.status(400).json({ error: 'task too short' });

  const sets = ['task=?'], vals = [trimmed];
  if (['ahora', 'hoy', 'semana'].includes(priority)) { sets.push('priority=?'); vals.push(priority); }
  const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
  if (cleanPhone) { sets.push('phone=?'); vals.push(cleanPhone); }
  // company y dueDate: solo se tocan si vienen en el body (permite asignar o limpiar)
  const hasCompany = Object.prototype.hasOwnProperty.call(body, 'company');
  const companyVal = hasCompany ? validCompany(company) : null;
  if (hasCompany) { sets.push('company=?'); vals.push(companyVal); }
  if (dueDate !== undefined) { sets.push('due_date=?'); vals.push(dueDate ? String(dueDate).slice(0, 10) : null); }

  vals.push(id);
  db.prepare("UPDATE tasks SET " + sets.join(', ') + " WHERE id=?").run(...vals);

  const t = db.prepare("SELECT contact FROM tasks WHERE id=?").get(id);
  if (cleanPhone && t?.contact) setCachedPhone(t.contact, cleanPhone);
  // Aprender empresa del contacto cuando Brandon la asigna manualmente
  if (hasCompany && companyVal && t?.contact && t.contact !== 'Yo') setCachedCompany(t.contact, companyVal);

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

app.get('/feedback/stats', (req, res) => {
  const stats = db.prepare("SELECT reason, COUNT(*) as n FROM feedback GROUP BY reason").all();
  const recent = db.prepare("SELECT contact, task, reason, created_at FROM feedback ORDER BY id DESC LIMIT 10").all();
  res.json({ stats, recent });
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

app.patch('/tasks/:id/feedback', (req, res) => {
  const id = parseInt(req.params.id);
  const { reason } = req.body || {};
  if (!id || !['error','done'].includes(reason)) return res.status(400).json({ error: 'invalid' });
  // Buscar la tarea para guardar contexto
  const task = db.prepare("SELECT contact, task, preview FROM tasks WHERE id=?").get(id);
  if (task) {
    db.prepare("INSERT INTO feedback (task_id, contact, task, preview, reason) VALUES (?,?,?,?,?)")
      .run(id, task.contact, task.task, task.preview, reason);
    // Si es error de IA, guardarlo en negativos para el prompt
    if (reason === 'error') {
      console.log('[FEEDBACK-ERROR] IA se equivocó: '+task.contact+': '+task.task);
    }
  }
  // Resolver la tarea
  db.prepare("UPDATE tasks SET status='resolved', resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  sseBroadcast('task_changed', { type: 'resolved', id });
  res.sendStatus(200);
});


app.post('/bot/command', async (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (!text || text.length < 2) return res.status(400).json({ error: 'texto vacio' });
  try {
    const r = await processBotCommand(text, null, req.body && req.body.company);
    res.json({ ok: true, task: r?.task || null, query: !!r?.query });
  } catch(e) {
    console.error('[SHORTCUT] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Quick-add por voz desde la PWA: recibe audio base64, transcribe con Whisper
// y lo procesa como un comando del bot.
app.post('/bot/audio', async (req, res) => {
  const { audio, mime } = req.body || {};
  if (!audio || typeof audio !== 'string') return res.status(400).json({ error: 'audio vacio' });
  try {
    const buffer = Buffer.from(audio, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'audio invalido' });
    const text = await transcribeBuffer(buffer, mime || '');
    if (!text || text.trim().length < 2) return res.status(422).json({ error: 'no se entendio el audio' });
    const r = await processBotCommand(text, null, req.body && req.body.company);
    res.json({ ok: true, text, task: r?.task || null, query: !!r?.query });
  } catch(e) {
    console.error('[AUDIO-WEB] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/reset', (req, res) => {
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM conv_history").run();
  db.prepare("DELETE FROM sin_responder_pending").run();
  sseBroadcast('task_changed', { type: 'reset' });
  console.log('[RESET] DB limpiada');
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v6.0 - empresas + vencimientos en puerto', process.env.PORT || 3001));
