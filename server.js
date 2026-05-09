require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const API_TOKEN = process.env.API_TOKEN || 'pendiente2024secret';
function authMiddleware(req, res, next) {
  if (req.path === '/webhook' || req.path === '/health' || req.path === '/stream') return next();
  const token = req.headers['x-api-token'] || req.query.token;
  if (token !== API_TOKEN) return res.status(401).json({ error: 'No autorizado' });
  next();
}
app.use((req, res, next) => {
  const allowedOrigins = ['https://pendienteia.vercel.app','http://localhost:3000'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
  else if (!origin) res.header('Access-Control-Allow-Origin', '*'); // WAHA/server calls sin origin
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
  CREATE TABLE IF NOT EXISTS sin_responder_pending (
    contact TEXT PRIMARY KEY,
    last_msg TEXT,
    key_message TEXT,
    category TEXT DEFAULT 'personal',
    scheduled_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_type ON tasks(type);
  CREATE INDEX IF NOT EXISTS idx_priority ON tasks(priority);
`);

// Migraciones seguras
const cols = db.pragma('table_info(tasks)').map(c => c.name);
if (!cols.includes('type')) db.exec("ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'pendiente'");
if (!cols.includes('from_me')) db.exec("ALTER TABLE tasks ADD COLUMN from_me INTEGER DEFAULT 0");
if (!cols.includes('actions')) db.exec("ALTER TABLE tasks ADD COLUMN actions TEXT");
if (!cols.includes('phone')) db.exec("ALTER TABLE tasks ADD COLUMN phone TEXT");
if (!cols.includes('key_message')) db.exec("ALTER TABLE tasks ADD COLUMN key_message TEXT");
// Fix task null: actualizar registros con task null o vacío
db.prepare("UPDATE tasks SET task='Revisar mensaje' WHERE task IS NULL OR task=''").run();

function cleanOldData() {
  db.prepare("DELETE FROM tasks WHERE status='resolved' AND resolved_at < datetime('now','-30 days')").run();
  db.prepare("DELETE FROM conv_history WHERE created_at < datetime('now','-1 day')").run();
}
cleanOldData();
const n3 = new Date(); n3.setHours(3,0,0,0);
if (n3 <= new Date()) n3.setDate(n3.getDate()+1);
setTimeout(()=>{cleanOldData();setInterval(cleanOldData,86400000);},n3-new Date());


// Limpieza inicial: consolidar duplicados existentes en pendiente
function consolidateDuplicates() {
  const dups = db.prepare(`
    SELECT contact, COUNT(*) as n FROM tasks
    WHERE status='pending' AND type='pendiente'
    GROUP BY contact HAVING n > 1
  `).all();
  for (const d of dups) {
    // Mantener solo la más reciente, marcar el resto como resueltas
    const keep = db.prepare(`
      SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='pendiente'
      ORDER BY created_at DESC LIMIT 1
    `).get(d.contact);
    if (keep) {
      const r = db.prepare(`
        UPDATE tasks SET status='resolved', resolved_at=CURRENT_TIMESTAMP
        WHERE contact=? AND status='pending' AND type='pendiente' AND id != ?
      `).run(d.contact, keep.id);
      console.log('[CONSOLIDATE] ' + d.contact + ': ' + r.changes + ' duplicados resueltos');
    }
  }
}
consolidateDuplicates();

// ─── EXTRACCIÓN DE ACCIONES CONTEXTUALES ──────────────────────────────────────
// Extrae datos estructurados con regex desde el texto real (anti-alucinación)
function extractActions(messages) {
  const text = messages.map(m => m.text || '').join(' ');
  const actions = [];
  const seen = new Set();

  // Teléfonos AR (móvil/fijo, con o sin +54, con o sin 9, con guiones/espacios)
  const phoneRegex = /(?:\+?54)?\s?9?\s?(?:11|2\d{2}|3\d{2})[\s\-]?\d{3,4}[\s\-]?\d{4}/g;
  const phones = text.match(phoneRegex) || [];
  for (const p of phones) {
    const clean = p.replace(/[^0-9+]/g, '');
    if (clean.length >= 10 && !seen.has('phone:'+clean)) {
      seen.add('phone:'+clean);
      // Normalizar a formato internacional
      let normalized = clean;
      if (!normalized.startsWith('+')) {
        if (normalized.startsWith('54')) normalized = '+' + normalized;
        else if (normalized.startsWith('9')) normalized = '+54' + normalized;
        else normalized = '+549' + normalized;
      }
      actions.push({ type: 'phone', value: normalized, label: p.trim() });
      actions.push({ type: 'whatsapp', value: normalized.replace(/\D/g,''), label: 'WhatsApp directo' });
    }
  }

  // Emails
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = text.match(emailRegex) || [];
  for (const e of emails) {
    if (!seen.has('email:'+e)) {
      seen.add('email:'+e);
      actions.push({ type: 'email', value: e, label: e });
    }
  }

  // CBU: 22 dígitos consecutivos
  const cbuRegex = /\b\d{22}\b/g;
  const cbus = text.match(cbuRegex) || [];
  for (const c of cbus) {
    if (!seen.has('cbu:'+c)) {
      seen.add('cbu:'+c);
      actions.push({ type: 'cbu', value: c, label: 'CBU: '+c.slice(0,4)+'...'+c.slice(-4) });
    }
  }

  // Alias: 6-20 chars con al menos un punto, letras y/o números
  const aliasRegex = /\b[a-zA-Z0-9]+\.[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\b/g;
  const aliasCandidates = text.match(aliasRegex) || [];
  for (const a of aliasCandidates) {
    // Filtrar: no debe ser email, no debe ser dominio común, debe tener 6-20 chars
    if (a.length < 6 || a.length > 20) continue;
    if (a.includes('@')) continue;
    if (/\.(com|ar|net|org|io|co|app|gov|edu)$/i.test(a)) continue;
    if (a.startsWith('.') || a.endsWith('.')) continue;
    // Solo si la palabra "alias" aparece cerca o no es un dominio conocido
    const ctx = text.toLowerCase();
    const idxOf = ctx.indexOf(a.toLowerCase());
    const around = ctx.slice(Math.max(0,idxOf-30), idxOf+a.length+30);
    if (!/alias|cbu|transferencia|cuenta|cvu|mercadop|pago/i.test(around)) continue;
    if (!seen.has('alias:'+a)) {
      seen.add('alias:'+a);
      actions.push({ type: 'alias', value: a, label: 'Alias: '+a });
    }
  }

  // Direcciones: detección básica (calle + número, palabras clave)
  const addressRegex = /(?:Av(?:enida)?\.?|Calle|Ruta)\s+[\w\s]+\d+(?:[,\s]+[\w\s]+)?/gi;
  const addresses = text.match(addressRegex) || [];
  for (const a of addresses) {
    if (a.length < 8 || a.length > 100) continue;
    if (!seen.has('addr:'+a)) {
      seen.add('addr:'+a);
      actions.push({ type: 'address', value: a.trim(), label: a.trim().slice(0, 40) });
    }
  }

  return actions;
}

// ─── COLA DE PROCESAMIENTO ────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── TRANSCRIPCIÓN DE AUDIO (Whisper en Groq vía SDK) ─────────────────────────
async function transcribeAudio(mediaUrl, mimetype) {
  try {
    const WAHA_API_KEY = process.env.WAHA_API_KEY || 'pendiente2024';

    // 1. Descargar el audio desde WAHA
    const audioRes = await fetch(mediaUrl, {
      headers: { 'X-Api-Key': WAHA_API_KEY }
    });
    if (!audioRes.ok) {
      console.error('[AUDIO] Error descargando:', audioRes.status);
      return null;
    }
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // 2. Verificar tamaño máximo (25 MB)
    if (audioBuffer.length > 25 * 1024 * 1024) {
      console.error('[AUDIO] Demasiado grande:', audioBuffer.length);
      return null;
    }

    console.log('[AUDIO] Descargado ' + audioBuffer.length + ' bytes, transcribiendo...');

    // 3. Guardar a archivo temporal (Groq SDK requiere File/stream, no Buffer directo)
    const fs = require('fs');
    const os = require('os');
    const tmpPath = path.join(os.tmpdir(), 'audio-' + Date.now() + '.ogg');
    fs.writeFileSync(tmpPath, audioBuffer);

    try {
      // 4. Usar el SDK de Groq que maneja multipart correctamente
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: 'whisper-large-v3-turbo',
        language: 'es',
        response_format: 'json',
      });

      const text = transcription.text?.trim() || '';
      console.log('[AUDIO] Transcrito (' + text.length + ' chars): ' + text.slice(0, 80));
      return text;
    } finally {
      // Limpiar archivo temporal
      try { fs.unlinkSync(tmpPath); } catch(e) {}
    }
  } catch(e) {
    console.error('[AUDIO] Error:', e.message);
    return null;
  }
}
let queue = [];
let processing = false;

async function enqueue(job) {
  queue.push(job);
  if (!processing) processQueue();
}
async function processQueue() {
  if (queue.length === 0) { processing = false; return; }
  processing = true;
  const job = queue.shift();
  try { await job(); } catch(e) { console.error('Queue error:', e.message); }
  setTimeout(processQueue, 2000);
}

// ─── HISTORIAL ────────────────────────────────────────────────────────────────
function saveToHistory(contact, text, fromMe) {
  db.prepare("INSERT INTO conv_history (contact, text, from_me) VALUES (?,?,?)").run(contact, text, fromMe?1:0);
}
function getRecentHistory(contact) {
  return db.prepare(`
    SELECT text, from_me FROM conv_history
    WHERE contact=? AND created_at > datetime('now','-6 hours')
    ORDER BY created_at ASC LIMIT 20
  `).all(contact).map(r => ({ text: r.text, fromMe: r.from_me===1 }));
}

// ─── GROQ ─────────────────────────────────────────────────────────────────────
let burstBuffer = {};
let phoneCache = {}; // contact → phone number

// ─── SSE: SERVER-SENT EVENTS ──────────────────────────────────────────────────
let sseClients = []; // Array de respuestas activas (cada cliente conectado)

function sseBroadcast(eventType, data) {
  const payload = 'event: ' + eventType + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
  sseClients = sseClients.filter(client => {
    try {
      client.write(payload);
      return true;
    } catch(e) {
      return false; // Cliente desconectado
    }
  });
  if (sseClients.length > 0) {
    console.log('[SSE] ' + eventType + ' → ' + sseClients.length + ' cliente(s)');
  }
}

// Heartbeat cada 30s para mantener viva la conexión (iOS cierra inactivas)
setInterval(() => {
  sseClients = sseClients.filter(client => {
    try { client.write(': heartbeat\n\n'); return true; }
    catch(e) { return false; }
  });
}, 30000);
 // solo para el timer de 20s

async function analyzeConversation(contact, messages) {
  const now = new Date();
  const timeStr = now.toLocaleString('es-AR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const conv = messages.map((m,i) => (i+1)+'. ['+(m.fromMe?'BRANDON':contact)+']: '+m.text).join('\n');
  const lastIsFromOther = messages.length > 0 && !messages[messages.length-1].fromMe;

  const res = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{
      role: 'user',
      content: `Sos el asistente personal de Brandon. Analizá esta conversación de WhatsApp.
Hora actual: ${timeStr}
Contacto: ${contact}
Último mensaje sin respuesta de Brandon: ${lastIsFromOther ? 'SÍ' : 'NO'}

CONVERSACIÓN (con contexto de horas anteriores si existe):
${conv}

BUSCÁ en el contexto completo:
1. ¿Evento, cita, reunión o plan acordado? ("dale el lunes", "nos vemos mañana", "sino dale X")
2. ¿Tarea o pedido concreto para Brandon?
3. ¿Brandon asumió un compromiso? ("yo me ocupo", "te llamo", "ya lo cerramos")

REGLAS:
- Evento o plan acordado entre ambos → needsAction:true, type:"mio"
- El otro le pide algo concreto a Brandon → needsAction:true, type:"pendiente"
- Brandon asumió compromiso → needsAction:true, type:"mio"
- NOTA: el campo sinResponder NO se usa acá, lo maneja el sistema por separado
- Charla sin acción ni compromiso concreto → needsAction:false

CATEGORÍA:
- "trabajo": transtide/financiera/cliente/proveedor/logistica/transporte/obra/aduana en nombre, o tema laboral
- "personal": amigos, familia, pareja, planes sociales

PRIORIDAD:
- "ahora": urgente hoy con hora concreta
- "hoy": acción necesaria hoy o plan para mañana
- "semana": evento o plan esta semana
- "ignorar": charla pura sin nada pendiente

Respondé SOLO JSON:
{
  "needsAction": true/false,
  "type": "pendiente|mio",
  "priority": "ahora|hoy|semana|ignorar",
  "category": "trabajo|personal",
  "keyMessage": "mensaje más relevante (máx 70 chars)",
  "task": "qué tiene que hacer Brandon, máximo 8 palabras",
  "meeting": { "date": "día/fecha", "time": "hora", "location": "lugar" } o null,
  "urgent": true/false
}`
    }],
    max_tokens: 300,
  });

  try {
    const content = res.choices[0].message.content.trim();
    const match = content.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { needsAction: false, priority: 'ignorar' };
  } catch(e) {
    return { needsAction: false, priority: 'ignorar' };
  }
}

function saveTask(contact, msgs, analysis, contactPhone) {
  if (!analysis.needsAction || analysis.priority === 'ignorar') return;
  
  // Extraer acciones contextuales con regex (validadas, no alucinadas)
  const extractedActions = extractActions(msgs);
  // Si la IA mandó actions también, mezclamos solo las que validemos
  if (Array.isArray(analysis.actions)) {
    for (const a of analysis.actions) {
      if (a.type === 'calendar' && (a.date || a.time)) {
        // Solo agregar calendar si tiene fecha o hora real
        extractedActions.push(a);
      }
    }
  }
  // Siempre agregar acción WhatsApp del contacto si tenemos su número
  const phoneFromContact = contactPhone || null;
  if (phoneFromContact && !extractedActions.some(a => a.type === 'whatsapp')) {
    extractedActions.push({ type: 'whatsapp_contact', value: phoneFromContact, label: 'Responder en WhatsApp' });
  }
  const actionsJson = extractedActions.length ? JSON.stringify(extractedActions) : null;

  // Validación: confidence mínima de 0.7 para evitar alucinaciones
  if (analysis.confidence !== undefined && analysis.confidence < 0.7) {
    console.log('[SKIP-LOW-CONF] '+contact+' (conf:'+analysis.confidence+'): '+(analysis.task||'?'));
    return;
  }

  // Validación de coherencia: la task debe usar palabras de los mensajes
  const allText = (msgs || []).map(m => (m.text || '').toLowerCase()).join(' ');
  const taskWords = (analysis.task || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4);
  // Palabras genéricas que no cuentan como "matchear"
  const generic = new Set(['responder','revisar','enviar','mandar','contactar','confirmar','llamar','consultar','preguntar','contestar','escribir','seguir','hacer','tarea','mensaje','sobre','para','cosa','algo','tema','reunir','reunion','asistir','recibir']);
  const meaningfulWords = taskWords.filter(w => !generic.has(w));

  if (meaningfulWords.length > 0) {
    const matched = meaningfulWords.some(w => allText.includes(w));
    if (!matched) {
      console.log('[SKIP-HALLUCINATION] '+contact+': "'+analysis.task+'" no matchea con mensajes reales');
      return;
    }
  }
  const meeting = (analysis.meeting?.date || analysis.meeting?.time) ? analysis.meeting : null;
  const type = analysis.type || 'pendiente';
  const lastMsg = msgs[msgs.length-1]?.text || '';
  const keyMsg = (analysis.keyMessage || lastMsg).slice(0, 150);
  const safeTask = (analysis.task || 'Revisar mensaje').slice(0, 100);

  // ── DEDUPLICACIÓN: si ya existe tarea del mismo contacto Y tarea similar, actualizar en vez de crear nueva ──
  // Para "pendiente": buscar si hay tarea reciente (últimas 2 horas) del mismo contacto
  // Para "mio": siempre una por contacto
  if (type === 'mio') {
    const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='mio' LIMIT 1").get(contact);
    if (existing) {
      db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,category=?,
        meeting_date=?,meeting_time=?,meeting_location=?,actions=?,phone=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(lastMsg.slice(0,80),keyMsg,safeTask,analysis.priority||'hoy',
          analysis.urgent?1:0,analysis.category||'personal',
          meeting?.date||null,meeting?.time||null,meeting?.location||null,
          actionsJson,phoneFromContact,existing.id);
      console.log('[MIO-UPDATE] '+contact+': '+safeTask);
      sseBroadcast('task_changed', { type: 'updated', taskType: 'mio', contact });
      return;
    }
  } else {
    // Para pendiente: si hay tarea del mismo contacto creada en las últimas 2 horas, actualizar
    const recentList = db.prepare(`
      SELECT id, task FROM tasks
      WHERE contact=? AND status='pending' AND type='pendiente'
      AND created_at > datetime('now', '-2 hours')
      ORDER BY created_at DESC LIMIT 5
    `).all(contact);

    // Buscar coincidencia por TEMA: comparar palabras significativas
    let matchedExisting = null;
    if (recentList.length > 0) {
      const generic = new Set(['responder','revisar','enviar','mandar','contactar','confirmar','llamar','consultar','preguntar','contestar','escribir','seguir','hacer','tarea','mensaje','para','sobre','cosa','algo','tema','obtener','recibir']);
      const newWords = (safeTask || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4 && !generic.has(w));
      for (const r of recentList) {
        const oldWords = (r.task || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4 && !generic.has(w));
        const shared = newWords.filter(w => oldWords.some(o => o.includes(w) || w.includes(o)));
        if (shared.length > 0) { matchedExisting = r; break; }
      }
    }

    if (matchedExisting) {
      db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,category=?,
        meeting_date=?,meeting_time=?,meeting_location=?,actions=?,phone=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(lastMsg.slice(0,80),keyMsg,safeTask,analysis.priority||'hoy',
          analysis.urgent?1:0,analysis.category||'personal',
          meeting?.date||null,meeting?.time||null,meeting?.location||null,
          actionsJson,phoneFromContact,matchedExisting.id);
      console.log('[PENDIENTE-UPDATE] '+contact+': '+safeTask);
      sseBroadcast('task_changed', { type: 'updated', taskType: 'pendiente', contact });
      return;
    }
    // No match → INSERT separado abajo
  }

  // Nueva tarea
  db.prepare(`INSERT INTO tasks
    (contact,preview,key_message,task,priority,urgent,category,type,from_me,meeting_date,meeting_time,meeting_location)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(contact,lastMsg.slice(0,80),keyMsg,safeTask,analysis.priority||'hoy',
      analysis.urgent?1:0,analysis.category||'personal',type,type==='mio'?1:0,
      meeting?.date||null,meeting?.time||null,meeting?.location||null);
  console.log('['+type.toUpperCase()+'-NEW]['+( analysis.priority||'hoy')+'] '+contact+': '+safeTask);
  sseBroadcast('task_changed', { type: 'new', taskType: type, contact });
}

// Sin responder: guardar con timestamp para calcular la demora después
let sinResponderPending = {}; // { contact: { lastMsg, analysis, timer } }

function scheduleSinResponder(contact, msgs, analysis) {
  // Esperar 1 hora antes de agregar a sin_responder
  const lastMsg = msgs[msgs.length-1]?.text || '';

  // Cancelar si ya había uno pendiente para este contacto
  if (sinResponderPending[contact]?.timer) clearTimeout(sinResponderPending[contact].timer);

  sinResponderPending[contact] = {
    timer: setTimeout(() => {
      delete sinResponderPending[contact];
      // Verificar que Brandon todavía no respondió
      const history = getRecentHistory(contact);
      const lastInHistory = history[history.length-1];
      if (lastInHistory && lastInHistory.fromMe) return; // ya respondió, no agregar

      const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='sin_responder' LIMIT 1").get(contact);
      if (!existing) {
        db.prepare("INSERT INTO tasks (contact,preview,key_message,task,priority,category,type) VALUES (?,?,?,?,?,?,?)")
          .run(contact,lastMsg.slice(0,80),(analysis.keyMessage||lastMsg).slice(0,150),
            'Responder a '+contact,'hoy',analysis.category||'personal','sin_responder');
        console.log('[SIN_RESPONDER - 1h] '+contact);
      }
    }, 60 * 60 * 1000) // 1 hora
  };
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Validar que el request viene de WAHA con su API key
  const wahaKey = req.headers['x-api-key'] || req.query.apiKey || req.body?.me?.id;
  const expectedKey = process.env.WAHA_API_KEY || 'pendiente2024';
  if (req.headers['x-api-key'] && req.headers['x-api-key'] !== expectedKey) {
    console.log('[WEBHOOK] Request rechazado - API key inválida');
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  try {
    const { event, payload } = req.body;
    if (event !== 'message') return;

    let text = payload.body || '';
    const contact = payload._data?.notifyName || payload.from || '';
    const fromMe = payload.fromMe || false;
    // Extraer número de teléfono del contacto (ej: 5491112345678@c.us → +5491112345678)
    const rawFrom = (payload.from || '').replace(/@.*$/, '');
    const contactPhoneNumber = /^\d{10,15}$/.test(rawFrom) ? '+' + rawFrom : null;
    const hasMedia = payload.hasMedia || false;
    const mediaType = payload._data?.type || payload.type || '';
    const mediaUrl = payload.media?.url || payload._data?.mediaUrl || null;
    const mimetype = payload.media?.mimetype || payload._data?.mimetype || '';

    if (contact === 'status@broadcast') return;
    if (!payload._data?.notifyName && contact.includes('@g.us')) return;

    // Si es audio/voz, transcribirlo con Whisper
    const isAudio = mediaType === 'ptt' || mediaType === 'audio' || mimetype.startsWith('audio/');
    if (isAudio && mediaUrl) {
      console.log('[AUDIO] Detectado de ' + contact + ', transcribiendo...');
      const transcribed = await transcribeAudio(mediaUrl, mimetype);
      if (transcribed && transcribed.length >= 3) {
        text = '[🎤 audio] ' + transcribed;
      } else {
        return; // Falló la transcripción
      }
    }

    if (!text || text.length < 3) return;

    // Guardar en historial persistente
    saveToHistory(contact, text, fromMe);

    if (fromMe) {
      // Brandon respondió → limpiar sin_responder activo y pending de SQLite
      db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE contact=? AND type='sin_responder' AND status='pending'").run(contact);
      db.prepare("DELETE FROM sin_responder_pending WHERE contact=?").run(contact);
    }

    // Resetear timer de burst (20s de silencio antes de analizar)
    if (!burstBuffer[contact]) burstBuffer[contact] = { timer: null };
    if (burstBuffer[contact].timer) clearTimeout(burstBuffer[contact].timer);

    burstBuffer[contact].timer = setTimeout(() => {
      delete burstBuffer[contact];

      enqueue(async () => {
        try {
          const history = getRecentHistory(contact);
          if (history.length === 0) return;

          const lastIsFromOther = !history[history.length-1].fromMe;

          // Analizar para tareas y compromisos
          const analysis = await analyzeConversation(contact, history);
          if (analysis.needsAction && analysis.priority !== 'ignorar') {
            saveTask(contact, history, analysis, phoneCache[contact] || null);
          }

          // Sin responder: solo si el último mensaje es del otro, programar para 1 hora después
          if (lastIsFromOther) {
            scheduleSinResponder(contact, history, analysis);
          }

        } catch(e) { console.error('Analysis error ['+contact+']:', e.message); }
      });
    }, 20000);

  } catch(e) { console.error('Webhook error:', e.message); }
});

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/tasks', (req, res) => {
  const type = req.query.type || 'pendiente';
  const tasks = db.prepare(`
    SELECT *, CAST((julianday('now')-julianday(created_at))*24 AS INTEGER) as hours
    FROM tasks WHERE status='pending' AND type=?
    ORDER BY CASE priority WHEN 'ahora' THEN 0 WHEN 'hoy' THEN 1 ELSE 2 END, created_at ASC
  `).all(type);
  res.json(tasks.map(t => ({
    id:t.id, contact:t.contact,
    preview:t.key_message||t.preview,
    task:t.task, priority:t.priority,
    urgent:t.urgent===1, category:t.category, type:t.type, fromMe:t.from_me===1,
    meeting:t.meeting_date||t.meeting_time?{date:t.meeting_date,time:t.meeting_time,location:t.meeting_location}:null,
    actions: t.actions ? (function(){ try { return JSON.parse(t.actions); } catch(e) { return []; } })() : [],
    phone: t.phone || null,
    hours:t.hours||0, createdAt:t.created_at,
  })));
});

app.delete('/tasks/:id', (req, res) => {
  db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  sseBroadcast('task_changed', { type: 'resolved', id: req.params.id });
  res.sendStatus(200);
});
app.patch('/tasks/:id/snooze', (req, res) => {
  db.prepare("UPDATE tasks SET priority='semana',urgent=0 WHERE id=?").run(req.params.id);
  sseBroadcast('task_changed', { type: 'snoozed', id: req.params.id });
  res.sendStatus(200);
});
app.patch('/tasks/:id/keep', (req, res) => {
  db.prepare("UPDATE tasks SET type='pendiente' WHERE id=?").run(req.params.id);
  sseBroadcast('task_changed', { type: 'kept', id: req.params.id });
  res.sendStatus(200);
});

app.patch('/tasks/:id/edit', (req, res) => {
  const { task, priority } = req.body || {};
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  if (!task || typeof task !== 'string') return res.status(400).json({ error: 'task required' });
  const trimmed = task.trim().slice(0, 200);
  if (trimmed.length < 2) return res.status(400).json({ error: 'task too short' });
  const validPrio = ['ahora','hoy','semana'].includes(priority) ? priority : null;
  if (validPrio) {
    db.prepare("UPDATE tasks SET task=?, priority=? WHERE id=?").run(trimmed, validPrio, id);
  } else {
    db.prepare("UPDATE tasks SET task=? WHERE id=?").run(trimmed, id);
  }
  sseBroadcast('task_changed', { type: 'edited', id });
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  const tasks = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='pending'").get();
  const hist = db.prepare("SELECT COUNT(*) as n FROM conv_history").get();
  res.json({ status:'ok', pendingTasks:tasks.n, queueLength:queue.length, historyMsgs:hist.n, sinResponderPending:db.prepare("SELECT COUNT(*) as n FROM sin_responder_pending").get().n });
});


app.get('/stream', (req, res) => {
  // Auth: aceptar token por query string (EventSource no permite headers custom)
  const token = req.query.token || req.headers['x-api-token'];
  if (token !== API_TOKEN) return res.status(401).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Para nginx/proxies
  });
  res.flushHeaders?.();

  // Mensaje inicial de conexión
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  sseClients.push(res);
  console.log('[SSE] Cliente conectado. Total: ' + sseClients.length);

  // Limpiar al desconectar
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    console.log('[SSE] Cliente desconectado. Total: ' + sseClients.length);
  });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v5.5 en puerto', process.env.PORT || 3001));
