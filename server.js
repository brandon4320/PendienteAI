require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const Database = require('better-sqlite3');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const WAHA_URL = process.env.WAHA_URL || 'http://localhost:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY || 'pendiente2024';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

// ─── SQLITE ───────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'tasks.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact TEXT NOT NULL,
    preview TEXT,
    key_message TEXT,
    task TEXT NOT NULL,
    priority TEXT DEFAULT 'hoy',
    urgent INTEGER DEFAULT 0,
    category TEXT DEFAULT 'personal',
    meeting_date TEXT,
    meeting_time TEXT,
    meeting_location TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_priority ON tasks(priority);
`);

function cleanOldTasks() {
  const r = db.prepare("DELETE FROM tasks WHERE status='resolved' AND resolved_at < datetime('now','-30 days')").run();
  if (r.changes > 0) console.log('Limpieza: ' + r.changes + ' tareas eliminadas');
}
cleanOldTasks();
const next3am = new Date(); next3am.setHours(3,0,0,0);
if (next3am <= new Date()) next3am.setDate(next3am.getDate()+1);
setTimeout(() => { cleanOldTasks(); setInterval(cleanOldTasks, 86400000); }, next3am - new Date());

// ─── GROQ ─────────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
let messageGroups = {};

const ALWAYS_CAPTURE = [
  /cita|mañana|hoy|esta noche|esta tarde|nos vemos|te espero|a las|venís|vengo|paso a buscar|vení|voy|yendo/i,
  /reunión|reunion|meeting|junta|llamada|llámame|llamame|urgente|importante|licitacion|licitación/i,
  /confirmá|confirmas|confirmame|me avisás|me avisas|podés|podes|necesito|necesitás/i,
  /cotizame|cotización|cotizacion|presupuesto|novedades|novedad|como va|cómo va|hay algo|sabés algo|sabes algo/i,
  /aduana|despacho|embarque|carga|mercadería|mercaderia|factura|remito|cheque|transferencia/i,
  /salimos|vamos|te animás|te animas|quedamos|juntamos|nos juntamos|acordate|te acordás/i,
  /avisame|avísame|contame|me decís|me dices|cuándo|cuando podés|cuando podes/i,
];

function hasUrgentKeywords(text) {
  return ALWAYS_CAPTURE.some(r => r.test(text));
}

async function analyzeMessage(contact, messages) {
  const now = new Date();
  const timeStr = now.toLocaleString('es-AR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const msgList = messages.map((m, i) => (i+1) + '. ' + m).join('\n');

  const res = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{
      role: 'user',
      content: `Sos mi asistente personal. Analizá estos mensajes de WhatsApp de un mismo contacto.
Hora actual: ${timeStr}
Contacto: ${contact}

MENSAJES:
${msgList}

Identificá el mensaje MÁS IMPORTANTE que requiere mi acción concreta.
Ignorá charla, ruido, respuestas sin acción requerida.

CATEGORÍA:
- "trabajo": transtide/financiera/cliente/proveedor/obra/aduana/despacho en nombre, o tema laboral
- "personal": pareja, amigos, familia, planes sociales

PRIORIDAD:
- "ahora": urgente con hora concreta hoy, licitación o reunión inminente
- "hoy": necesita respuesta hoy, plan para mañana que requiere confirmación
- "semana": planes futuros sin urgencia inmediata
- "ignorar": solo si NO hay ningún mensaje que requiera acción concreta

Respondé SOLO en JSON:
{
  "needsAction": true/false,
  "priority": "ahora|hoy|semana|ignorar",
  "category": "trabajo|personal",
  "keyMessage": "el mensaje más importante (máx 60 chars)",
  "task": "qué tengo que hacer YO, específico, máximo 7 palabras",
  "meeting": { "date": "fecha si hay", "time": "hora si hay", "location": "lugar si hay" } o null,
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

// ─── HISTÓRICO: leer chats de WAHA ────────────────────────────────────────────
app.get('/history-scan', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 15;
    const since = Date.now() - (days * 24 * 60 * 60 * 1000);

    // Obtener lista de chats
    const chatsRes = await fetch(
      `${WAHA_URL}/api/${WAHA_SESSION}/chats/overview`,
      { headers: { 'X-Api-Key': WAHA_API_KEY } }
    );

    if (!chatsRes.ok) throw new Error('WAHA no responde: ' + chatsRes.status);
    const chats = await chatsRes.json();

    // Filtrar chats con actividad en los últimos N días
    const recent = chats
      .filter(c => {
        if (!c.lastMessage) return false;
        const msgTime = (c.lastMessage.timestamp || 0) * 1000;
        return msgTime >= since;
      })
      .map(c => ({
        id: c.id,
        name: c.name || c.id,
        lastMessage: c.lastMessage?.body?.slice(0, 80) || '',
        lastTime: c.lastMessage?.timestamp || 0,
        isGroup: c.id.includes('@g.us'),
        msgCount: c.unreadCount || 0,
      }))
      .sort((a, b) => b.lastTime - a.lastTime)
      .slice(0, 100); // Máximo 100 chats

    res.json({ chats: recent, total: recent.length, days });
  } catch(e) {
    console.error('History scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Analizar mensajes de un chat específico
app.post('/history-analyze', async (req, res) => {
  const { chatId, contactName } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId requerido' });

  try {
    const days = 15;
    const since = Math.floor((Date.now() - days * 86400000) / 1000);

    // Obtener mensajes del chat
    const msgsRes = await fetch(
      `${WAHA_URL}/api/${WAHA_SESSION}/chats/${encodeURIComponent(chatId)}/messages?limit=50&downloadMedia=false`,
      { headers: { 'X-Api-Key': WAHA_API_KEY } }
    );

    if (!msgsRes.ok) throw new Error('Error obteniendo mensajes');
    const msgs = await msgsRes.json();

    // Filtrar: solo mensajes recibidos (no míos) en los últimos 15 días
    const received = msgs
      .filter(m => !m.fromMe && m.timestamp >= since && m.body && m.body.length > 2)
      .map(m => m.body)
      .slice(0, 20); // Max 20 mensajes por chat

    if (!received.length) return res.json({ skipped: true, reason: 'No hay mensajes recibidos' });

    // Analizar con IA
    const analysis = await analyzeMessage(contactName || chatId, received);

    if (!analysis.needsAction || analysis.priority === 'ignorar') {
      return res.json({ skipped: true, reason: 'No requiere acción' });
    }

    // Guardar en DB si no existe ya
    const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' LIMIT 1").get(contactName || chatId);
    if (!existing) {
      db.prepare(`INSERT INTO tasks (contact, preview, key_message, task, priority, urgent, category, meeting_date, meeting_time, meeting_location)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        contactName || chatId,
        received[received.length-1].slice(0,80),
        (analysis.keyMessage || received[received.length-1]).slice(0,150),
        analysis.task,
        analysis.priority || 'hoy',
        analysis.urgent ? 1 : 0,
        analysis.category || 'personal',
        analysis.meeting?.date || null,
        analysis.meeting?.time || null,
        analysis.meeting?.location || null
      );
    }

    res.json({ saved: true, task: analysis.task, priority: analysis.priority, category: analysis.category });
  } catch(e) {
    console.error('History analyze error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { event, payload } = req.body;
    if (event !== 'message') return;
    if (payload.fromMe) return;

    const text = payload.body || '';
    const contact = payload._data?.notifyName || payload.from || '';

    if (contact === 'status@broadcast') return;
    if (!payload._data?.notifyName && contact.includes('@g.us')) return;
    if (!text || text.length < 3) return;

    if (!messageGroups[contact]) messageGroups[contact] = { messages: [], timer: null };
    messageGroups[contact].messages.push(text);
    if (messageGroups[contact].timer) clearTimeout(messageGroups[contact].timer);

    const delay = hasUrgentKeywords(text) ? 5000 : 30000;

    messageGroups[contact].timer = setTimeout(async () => {
      const msgs = [...messageGroups[contact].messages];
      delete messageGroups[contact];

      const analysis = await analyzeMessage(contact, msgs);
      const forcedCapture = msgs.some(m => hasUrgentKeywords(m));

      if (analysis.priority === 'ignorar' && !forcedCapture) return;
      if (!analysis.needsAction && !forcedCapture) return;

      if (forcedCapture && !analysis.needsAction) {
        analysis.needsAction = true;
        analysis.priority = analysis.priority === 'ignorar' ? 'hoy' : analysis.priority;
        analysis.task = analysis.task || 'Responder mensaje importante';
        analysis.keyMessage = analysis.keyMessage || msgs[msgs.length - 1];
      }

      const meeting = analysis.meeting?.time ? analysis.meeting : null;
      const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' LIMIT 1").get(contact);

      if (existing) {
        db.prepare(`UPDATE tasks SET preview=?, key_message=?, task=?, priority=?, urgent=?,
          category=?, meeting_date=?, meeting_time=?, meeting_location=?, created_at=CURRENT_TIMESTAMP WHERE id=?`
        ).run(msgs[msgs.length-1].slice(0,80), (analysis.keyMessage||msgs[msgs.length-1]).slice(0,150),
          analysis.task, analysis.priority||'hoy', analysis.urgent?1:0, analysis.category||'personal',
          meeting?.date||null, meeting?.time||null, meeting?.location||null, existing.id);
      } else {
        db.prepare(`INSERT INTO tasks (contact,preview,key_message,task,priority,urgent,category,meeting_date,meeting_time,meeting_location)
          VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(contact, msgs[msgs.length-1].slice(0,80), (analysis.keyMessage||msgs[msgs.length-1]).slice(0,150),
          analysis.task, analysis.priority||'hoy', analysis.urgent?1:0, analysis.category||'personal',
          meeting?.date||null, meeting?.time||null, meeting?.location||null);
      }

      console.log('[' + (analysis.priority||'hoy').toUpperCase() + '][' + (analysis.category||'personal') + '] ' + contact + ': ' + analysis.task);
    }, delay);

  } catch(e) { console.error('Webhook error:', e.message); }
});

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/tasks', (req, res) => {
  const tasks = db.prepare(`SELECT *, CAST((julianday('now')-julianday(created_at))*24 AS INTEGER) as hours
    FROM tasks WHERE status='pending'
    ORDER BY CASE priority WHEN 'ahora' THEN 0 WHEN 'hoy' THEN 1 ELSE 2 END, created_at ASC`).all();
  res.json(tasks.map(t => ({
    id:t.id, contact:t.contact, preview:t.key_message||t.preview, task:t.task,
    priority:t.priority, urgent:t.urgent===1, category:t.category,
    meeting:t.meeting_time?{date:t.meeting_date,time:t.meeting_time,location:t.meeting_location}:null,
    hours:t.hours||0, createdAt:t.created_at,
  })));
});

app.delete('/tasks/:id', (req, res) => {
  db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  res.sendStatus(200);
});

app.patch('/tasks/:id/snooze', (req, res) => {
  db.prepare("UPDATE tasks SET priority='semana',urgent=0 WHERE id=?").run(req.params.id);
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='pending'").get();
  res.json({ status:'ok', pendingTasks:count.n, pendingGroups:Object.keys(messageGroups).length });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v3.2 en puerto', process.env.PORT || 3001));
