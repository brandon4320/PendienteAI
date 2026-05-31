// ─── MÓDULOS REFACTORIZADOS (backend/src) ───────────────────────────────────
// Config, conexión a DB, migraciones y helpers compartidos. El comportamiento
// es idéntico al anterior: solo se movieron a archivos separados.
const env = require('./backend/src/config/env'); // carga dotenv (raíz) + centraliza process.env
const C = require('./backend/src/config/constants');
const log = require('./backend/src/shared/logger');
const db = require('./backend/src/db/connection');
const { runMigrations } = require('./backend/src/db/migrations');
const {
  todayISO_AR, toISO, addDaysISO, daysInMonth, addMonthsClamped,
  advanceRunISO, computeNextRunISO,
} = require('./backend/src/shared/date');
const { validCompany, validDate, audioExtFromMime, parseId } = require('./backend/src/shared/validation');

// Módulo de tareas (repository/service/controller/routes). El service recibe
// por inyección las dependencias que viven en server.js (SSE + caches de
// contacto + extractActions), que son declaraciones de función hoisteadas.
const taskRepo = require('./backend/src/modules/tasks/task.repository');
const { createTaskService } = require('./backend/src/modules/tasks/task.service');
const { createTaskController } = require('./backend/src/modules/tasks/task.controller');
const { createTaskRoutes } = require('./backend/src/modules/tasks/task.routes');
const taskService = createTaskService({
  sseBroadcast: (...a) => sseBroadcast(...a),
  getCachedCompany: (...a) => getCachedCompany(...a),
  setCachedCompany: (...a) => setCachedCompany(...a),
  setCachedPhone: (...a) => setCachedPhone(...a),
  extractActions: (...a) => extractActions(...a),
});
const taskController = createTaskController({ taskService });
const taskRouter = createTaskRoutes({ taskController });

const express = require('express');
const Groq = require('groq-sdk');
const path = require('path');
const fsAsync = require('fs').promises;
const fsSync = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const API_TOKEN = env.API_TOKEN;
if (!API_TOKEN) {
  log.error('[STARTUP] ADVERTENCIA: API_TOKEN no está en .env — todas las peticiones autenticadas serán rechazadas');
}

function authMiddleware(req, res, next) {
  if (req.path === '/webhook' || req.path === '/health' || req.path === '/stream') return next();
  const token = req.headers['x-api-token'] || req.query.token;
  if (!API_TOKEN || token !== API_TOKEN) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.use((req, res, next) => {
  const allowedOrigins = C.ALLOWED_ORIGINS;
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
// La conexión vive en backend/src/db/connection.js y las tablas/migraciones en
// backend/src/db/migrations.js. Comportamiento idéntico al anterior.
runMigrations(db);
function getSetting(k, def) { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r ? r.value : def; }
function setSetting(k, v) { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(k, String(v)); }

// ─── EMPRESAS ───────────────────────────────────────────────────────────────
// Claves canónicas (lo que se guarda en DB) en C.COMPANIES; validCompany/validDate
// viven en backend/src/shared/validation.js.
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
  taskRepo.deleteOldResolved();
  db.prepare("DELETE FROM conv_history WHERE created_at < datetime('now','-1 day')").run();
}
cleanOldData();

// Escalado por vencimiento (taskService.escalateDueDates): las tareas con
// due_date suben de prioridad al acercarse. Alias local para no tocar los
// muchos call sites de los schedulers.
const escalateDueDates = () => taskService.escalateDueDates();
// ─── RECURRENTES ────────────────────────────────────────────────────────────
// Los helpers de fecha (todayISO_AR, toISO, addDaysISO, daysInMonth,
// addMonthsClamped, advanceRunISO, computeNextRunISO) viven en
// backend/src/shared/date.js y se importan arriba.
// Genera las tareas de las reglas que vencen hoy o antes, y avanza next_run
function runRecurring() {
  const today = todayISO_AR();
  const due = db.prepare("SELECT * FROM recurring WHERE active=1 AND next_run IS NOT NULL AND next_run <= ?").all(today);
  let created = 0;
  for (const r of due) {
    if (r.last_created !== r.next_run) {
      taskRepo.insertRecurringTask({
        preview: r.title.slice(0, 80),
        keyMessage: r.title.slice(0, 150),
        task: r.title.slice(0, 100),
        priority: r.priority || 'hoy',
        category: r.category || 'trabajo',
        company: validCompany(r.company),
        dueDate: r.next_run,
      });
      created++;
    }
    // Avanzar a la próxima ocurrencia (saltando intervalo) hasta que quede en el futuro
    let nr = r.next_run, guard = 0;
    do { nr = advanceRunISO(r, nr); guard++; } while (nr <= today && guard < 1000);
    db.prepare("UPDATE recurring SET last_created=?, next_run=? WHERE id=?").run(r.next_run, nr, r.id);
  }
  if (created) {
    console.log('[RECURRING] ' + created + ' tareas generadas');
    escalateDueDates();
    sseBroadcast('task_changed', { type: 'recurring' });
  }
}

escalateDueDates();
runRecurring();
setInterval(escalateDueDates, 3 * 60 * 60 * 1000); // cada 3 horas

// Programar limpieza diaria a las 3am
const n3 = new Date(); n3.setHours(3, 0, 0, 0);
if (n3 <= new Date()) n3.setDate(n3.getDate() + 1);
setTimeout(() => {
  cleanOldData(); escalateDueDates(); runRecurring();
  setInterval(() => { cleanOldData(); escalateDueDates(); runRecurring(); }, 86400000);
}, Math.max(0, n3 - new Date()));

// consolidateDuplicates vive en taskService (módulo tasks).
taskService.consolidateDuplicates();

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
const groq = new Groq({ apiKey: env.GROQ_API_KEY });

// ─── AUDIO (Whisper) ──────────────────────────────────────────────────────────
// audioExtFromMime vive en backend/src/shared/validation.js (importado arriba).

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
      model: C.GROQ_AUDIO_MODEL,
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
    const WAHA_API_KEY = env.WAHA_API_KEY;
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
  setTimeout(processQueue, C.QUEUE_DELAY_MS);
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
const SSE_MAX_CLIENTS = C.SSE_MAX_CLIENTS;
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
}, C.SSE_HEARTBEAT_MS);

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
    model: C.GROQ_TEXT_MODEL,
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

// saveTask vive ahora en taskService.saveTask (módulo tasks). Alias local para
// no tocar los call sites (webhook).
const saveTask = (...a) => taskService.saveTask(...a);

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
      const existing = taskRepo.findPendingByContactType(contact, 'sin_responder');
      if (!existing) {
        const phone = getCachedPhone(contact) || contactPhone || null;
        const srActions = [];
        if (phone) srActions.push({ type: 'whatsapp_contact', value: phone.replace(/\D/g, ''), label: 'WhatsApp' });
        srActions.push({ type: 'calendar', title: 'Responder a ' + contact, date: null, time: null, location: null });
        taskRepo.insertSinResponder({
          contact,
          preview: lastMsg.slice(0, 80),
          keyMessage: (analysis.keyMessage || lastMsg).slice(0, 150),
          task: 'Responder a ' + contact,
          priority: 'hoy',
          category: analysis.category || 'personal',
          company: getCachedCompany(contact) || validCompany(analysis.company) || null,
          phone,
          actions: JSON.stringify(srActions),
        });
        console.log('[SIN_RESPONDER - 4h] ' + contact);
        sseBroadcast('task_changed', { type: 'new', taskType: 'sin_responder', contact });
      }
    }, 4 * 60 * 60 * 1000)
  };
}

// ─── RATE LIMIT (webhook) ─────────────────────────────────────────────────────
const _webhookRL = {};
const WEBHOOK_RPM = C.WEBHOOK_RPM;
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
const PHONE_CACHE_TTL = C.PHONE_CACHE_TTL;
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
const MY_WA_NUMBER = env.MY_WA_NUMBER;
const SERVWHITE_NUMBER = C.SERVWHITE_NUMBER;
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
    const WAHA_URL2 = env.WAHA_URL;
    const WAHA_KEY2 = env.WAHA_API_KEY || 'pendiente2024';
    const WAHA_SES2 = env.WAHA_SESSION;
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
    const tasks = taskRepo.listPendingBrief();
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
      messages: [{ role: 'user', content: 'Sos el asistente de Brandon. El te manda este mensaje para anotar una tarea. Hora: ' + timeStr + '. Hoy es ' + todayAR + ' (YYYY-MM-DD). Brandon maneja 6 empresas: financiera (prestamos/creditos/finanzas), serviwhite (modulos/containers), tecnophos (tecnologia/quimica/industria), adc, transtide (fletes/logistica/freight/aduana), svn (SVN Designs/diseño/web). Si la tarea es de una empresa usa su clave, si es personal usa "personal", si no sabes usa null. Si hay una fecha limite/vencimiento, calcula dueDate exacto en YYYY-MM-DD desde la fecha de hoy, sino null. Si el mensaje indica que se REPITE (todos los dias, cada lunes, cada 2 semanas, todos los meses el 20, cada 6 meses, cada año), completa recurring. interval = cada cuantos (ej "cada 6 meses"=monthly interval 6; "cada 2 semanas"=weekly interval 2; default 1). dayOfWeek 0=domingo..6=sabado; dayOfMonth 1-31; month 1-12. Si no se repite, cadence null. Mensaje: "' + text + '". Responde SOLO JSON: {"task":"descripcion max 10 palabras","type":"pendiente o mio","priority":"ahora hoy o semana","category":"trabajo o personal","company":"financiera|serviwhite|tecnophos|adc|transtide|svn|personal|null","dueDate":"YYYY-MM-DD o null","recurring":{"cadence":"daily|weekly|monthly|yearly o null","interval":"N o 1","dayOfWeek":"0-6 o null","dayOfMonth":"1-31 o null","month":"1-12 o null"},"contact":null,"meeting":{"date":null,"time":null},"reply":"confirmacion max 10 palabras"}' }],
      max_tokens: 250,
    });
    const match = res.choices[0].message.content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json');
    const a = JSON.parse(match[0]);
    if (!a.task) throw new Error('no task');

    // ¿Es una tarea recurrente? → crear regla en vez de tarea suelta
    if (a.recurring && CADENCES.includes(a.recurring.cadence)) {
      const built = buildRuleFromBody({
        title: a.task, company: companyHint || a.company, priority: a.priority, category: a.category,
        cadence: a.recurring.cadence, interval: a.recurring.interval, dayOfWeek: a.recurring.dayOfWeek, dayOfMonth: a.recurring.dayOfMonth, month: a.recurring.month,
      });
      if (built.rule) {
        const rule = built.rule;
        const nextRun = computeNextRunISO(rule, todayISO_AR());
        db.prepare(`INSERT INTO recurring (title,company,priority,category,cadence,interval,day_of_week,day_of_month,month,next_run)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(rule.title, rule.company, rule.priority, rule.category, rule.cadence, rule.interval, rule.day_of_week, rule.day_of_month, rule.month, nextRun);
        runRecurring();
        sseBroadcast('task_changed', { type: 'recurring_rule' });
        console.log('[BOT] Recurrente creada: ' + rule.title + ' (' + rule.cadence + ')');
        if (fromId) await sendWAMessage(fromId, ROBOT + ' ' + CHECK + ' Recurrente: ' + rule.title);
        return { recurring: true, task: rule.title };
      }
    }

    const meet = (a.meeting && (a.meeting.date || a.meeting.time)) ? a.meeting : null;
    taskRepo.insertBotTask({
      contact: a.contact || 'Yo',
      preview: text.slice(0, 80),
      keyMessage: text.slice(0, 150),
      task: a.task,
      priority: a.priority || 'hoy',
      category: a.category || 'personal',
      company: validCompany(companyHint) || validCompany(a.company),
      dueDate: validDate(a.dueDate),
      type: a.type || 'pendiente',
      meetingDate: meet ? meet.date : null,
      meetingTime: meet ? meet.time : null,
    });
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
  const expectedKey = env.WAHA_API_KEY;
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
      taskRepo.resolveSinResponderByContact(contact);
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
// Rutas de tareas (GET /tasks, DELETE /tasks/:id, PATCH .../snooze|postpone|keep|edit|feedback)
// movidas al módulo backend/src/modules/tasks. Se montan acá, después de authMiddleware.
app.use(taskRouter);

// parseId (valida que el :id sea entero positivo) vive en
// backend/src/shared/validation.js (importado arriba).

// ─── RECURRENTES API ───────────────────────────────────────────────────────
const CADENCES = C.CADENCES;
function buildRuleFromBody(body) {
  const title = (body.title || '').trim().slice(0, 120);
  if (title.length < 2) return { error: 'title required' };
  const cadence = CADENCES.includes(body.cadence) ? body.cadence : null;
  if (!cadence) return { error: 'cadence invalid' };
  return {
    rule: {
      title,
      company: validCompany(body.company),
      priority: ['ahora', 'hoy', 'semana'].includes(body.priority) ? body.priority : 'hoy',
      category: body.category === 'personal' ? 'personal' : 'trabajo',
      cadence,
      interval: Math.min(Math.max(parseInt(body.interval, 10) || 1, 1), 99),
      day_of_week: cadence === 'weekly' ? Math.min(Math.max(parseInt(body.dayOfWeek, 10) || 0, 0), 6) : null,
      day_of_month: (cadence === 'monthly' || cadence === 'yearly') ? Math.min(Math.max(parseInt(body.dayOfMonth, 10) || 1, 1), 31) : null,
      month: cadence === 'yearly' ? Math.min(Math.max(parseInt(body.month, 10) || 1, 1), 12) : null,
    }
  };
}

app.get('/recurring', (req, res) => {
  const rows = db.prepare("SELECT * FROM recurring ORDER BY active DESC, next_run ASC").all();
  res.json(rows.map(r => ({
    id: r.id, title: r.title, company: r.company, priority: r.priority, category: r.category,
    cadence: r.cadence, interval: r.interval || 1, dayOfWeek: r.day_of_week, dayOfMonth: r.day_of_month, month: r.month,
    active: r.active === 1, nextRun: r.next_run, lastCreated: r.last_created,
  })));
});

app.post('/recurring', (req, res) => {
  const { rule, error } = buildRuleFromBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const nextRun = computeNextRunISO(rule, todayISO_AR());
  const info = db.prepare(`INSERT INTO recurring (title,company,priority,category,cadence,interval,day_of_week,day_of_month,month,next_run)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(rule.title, rule.company, rule.priority, rule.category, rule.cadence, rule.interval, rule.day_of_week, rule.day_of_month, rule.month, nextRun);
  runRecurring(); // si toca hoy, genera la primera ya
  sseBroadcast('task_changed', { type: 'recurring_rule' });
  res.json({ ok: true, id: info.lastInsertRowid, nextRun });
});

app.patch('/recurring/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  if (typeof (req.body || {}).active === 'boolean') {
    db.prepare("UPDATE recurring SET active=? WHERE id=?").run(req.body.active ? 1 : 0, id);
  }
  sseBroadcast('task_changed', { type: 'recurring_rule' });
  res.sendStatus(200);
});

app.delete('/recurring/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  db.prepare("DELETE FROM recurring WHERE id=?").run(id);
  sseBroadcast('task_changed', { type: 'recurring_rule' });
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
  const pendingTasks = taskRepo.countPending();
  const hist = db.prepare("SELECT COUNT(*) as n FROM conv_history").get();
  res.json({
    status: 'ok',
    pendingTasks,
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

// PATCH /tasks/:id/feedback movido al módulo tasks (montado vía taskRouter arriba).


app.post('/bot/command', async (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (!text || text.length < 2) return res.status(400).json({ error: 'texto vacio' });
  try {
    const r = await processBotCommand(text, null, req.body && req.body.company);
    res.json({ ok: true, task: r?.task || null, query: !!r?.query, recurring: !!r?.recurring });
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
    res.json({ ok: true, text, task: r?.task || null, query: !!r?.query, recurring: !!r?.recurring });
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

// ─── DIGEST POR WHATSAPP (Fase 4) ────────────────────────────────────────────
const COMPANY_NAMES = C.COMPANY_NAMES;
function compName(c) { return COMPANY_NAMES[c] || 'Sin empresa'; }
function ddmm(iso) { return iso.slice(8, 10) + '/' + iso.slice(5, 7); }

function buildDailyDigest() {
  const ROBOT = String.fromCodePoint(0x1F916), CAL = String.fromCodePoint(0x1F4C5),
    WARN = String.fromCodePoint(0x26A0), CLIP = String.fromCodePoint(0x1F4CB), PARTY = String.fromCodePoint(0x1F389);
  const today = todayISO_AR(), tomorrow = addDaysISO(today, 1);
  const tasks = taskRepo.listPendingForDigest();
  if (!tasks.length) return ROBOT + ' Buen dia Brandon! No tenes pendientes. ' + PARTY;
  let msg = ROBOT + ' Buen dia Brandon\n' + CAL + ' ' + today + '\n';
  const urgent = tasks.filter(t => t.due_date && t.due_date <= tomorrow);
  if (urgent.length) {
    msg += '\n' + WARN + ' Para hoy / vencidas:\n';
    urgent.slice(0, 10).forEach(t => { msg += '- [' + compName(t.company) + '] ' + t.task + (t.due_date < today ? ' (vencida)' : '') + '\n'; });
  }
  const counts = {};
  tasks.forEach(t => { const k = t.company || '_'; counts[k] = (counts[k] || 0) + 1; });
  msg += '\n' + CLIP + ' Pendientes por empresa:\n';
  Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(k => { msg += '- ' + compName(k === '_' ? null : k) + ': ' + counts[k] + '\n'; });
  msg += '\nTotal: ' + tasks.length + ' pendientes';
  return msg.trim();
}
function buildWeeklyDigest() {
  const ROBOT = String.fromCodePoint(0x1F916), CAL = String.fromCodePoint(0x1F4C5);
  const today = todayISO_AR(), in7 = addDaysISO(today, 7);
  const tasks = taskRepo.listDueWithin(in7);
  if (!tasks.length) return ROBOT + ' Semana tranquila: sin vencimientos en los proximos 7 dias.';
  let msg = ROBOT + ' ' + CAL + ' Tu semana (' + tasks.length + ' vencimientos):\n\n';
  tasks.forEach(t => { msg += '- ' + ddmm(t.due_date) + ' [' + compName(t.company) + '] ' + t.task + '\n'; });
  return msg.trim();
}
async function sendDailyDigest() { await sendWAMessage(MY_WA_NUMBER, buildDailyDigest()); console.log('[DIGEST] diario enviado'); }
async function sendWeeklyDigest() { await sendWAMessage(MY_WA_NUMBER, buildWeeklyDigest()); console.log('[DIGEST] semanal enviado'); }

// Scheduler: chequea la hora AR cada minuto
let _lastDaily = null, _lastWeekly = null;
setInterval(() => {
  try {
    const dateStr = todayISO_AR();
    const hhmm = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' });
    const wd = new Date().toLocaleDateString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' });
    if (getSetting('digest_enabled', '1') === '1' && hhmm === getSetting('digest_time', '08:00') && _lastDaily !== dateStr) {
      _lastDaily = dateStr; sendDailyDigest().catch(e => console.error('[DIGEST]', e.message));
    }
    if (getSetting('weekly_enabled', '1') === '1' && wd === 'Sun' && hhmm === getSetting('weekly_time', '18:00') && _lastWeekly !== dateStr) {
      _lastWeekly = dateStr; sendWeeklyDigest().catch(e => console.error('[DIGEST]', e.message));
    }
  } catch (e) { console.error('[DIGEST] sched', e.message); }
}, 60 * 1000);

app.get('/settings', (req, res) => {
  res.json({
    digestEnabled: getSetting('digest_enabled', '1') === '1',
    digestTime: getSetting('digest_time', '08:00'),
    weeklyEnabled: getSetting('weekly_enabled', '1') === '1',
    weeklyTime: getSetting('weekly_time', '18:00'),
  });
});
app.patch('/settings', (req, res) => {
  const b = req.body || {};
  if (typeof b.digestEnabled === 'boolean') setSetting('digest_enabled', b.digestEnabled ? '1' : '0');
  if (typeof b.weeklyEnabled === 'boolean') setSetting('weekly_enabled', b.weeklyEnabled ? '1' : '0');
  if (/^\d{2}:\d{2}$/.test(b.digestTime || '')) setSetting('digest_time', b.digestTime);
  if (/^\d{2}:\d{2}$/.test(b.weeklyTime || '')) setSetting('weekly_time', b.weeklyTime);
  res.json({ ok: true });
});
app.post('/digest/test', async (req, res) => {
  const text = buildDailyDigest();
  if (req.query.preview === '1' || (req.body && req.body.preview)) return res.json({ ok: true, text, sent: false });
  try { await sendWAMessage(MY_WA_NUMBER, text); res.json({ ok: true, sent: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(env.PORT, () => log.info('PendienteAI v6.3 - vista Hoy + posponer a fecha en puerto', env.PORT));
