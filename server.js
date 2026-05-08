require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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
  /reunión|meeting|junta|llamada|llámame|llamame|urgente|importante/i,
  /confirmá|confirmame|me avisás|me avisas|podés|podes|necesito|necesitás/i,
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

MENSAJES (en orden cronológico):
${msgList}

TU TAREA:
1. Identificá el mensaje MÁS IMPORTANTE que requiere mi acción (ignorá los que son solo charla, respuestas, ruido)
2. El mensaje clave es el que me pide algo concreto: ir a algún lugar, confirmar algo, llamar, reunirse, pagar, etc.
3. La tarea debe ser ESPECÍFICA y basada en el mensaje clave, no en todos los mensajes

CATEGORÍA:
- "trabajo": nombre con transtide/financiera/cliente/proveedor/obra, o tema laboral
- "personal": pareja, amigos, familia, planes sociales

PRIORIDAD:
- "ahora": urgente con hora concreta hoy
- "hoy": necesita respuesta hoy, plan para mañana que requiere confirmación
- "semana": planes futuros sin urgencia inmediata
- "ignorar": solo si NO hay ningún mensaje que requiera acción concreta

Respondé SOLO en JSON:
{
  "needsAction": true/false,
  "priority": "ahora|hoy|semana|ignorar",
  "category": "trabajo|personal",
  "keyMessage": "el mensaje más importante textualmente (máx 60 chars)",
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
        db.prepare(`UPDATE tasks SET
          preview=?, key_message=?, task=?, priority=?, urgent=?,
          category=?, meeting_date=?, meeting_time=?, meeting_location=?,
          created_at=CURRENT_TIMESTAMP WHERE id=?`
        ).run(
          msgs[msgs.length-1].slice(0,80),
          (analysis.keyMessage || msgs[msgs.length-1]).slice(0,150),
          analysis.task,
          analysis.priority || 'hoy',
          analysis.urgent ? 1 : 0,
          analysis.category || 'personal',
          meeting?.date || null, meeting?.time || null, meeting?.location || null,
          existing.id
        );
        console.log('[UPDATE][' + analysis.priority + '] ' + contact + ': ' + analysis.task);
      } else {
        db.prepare(`INSERT INTO tasks
          (contact, preview, key_message, task, priority, urgent, category, meeting_date, meeting_time, meeting_location)
          VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(
          contact,
          msgs[msgs.length-1].slice(0,80),
          (analysis.keyMessage || msgs[msgs.length-1]).slice(0,150),
          analysis.task,
          analysis.priority || 'hoy',
          analysis.urgent ? 1 : 0,
          analysis.category || 'personal',
          meeting?.date || null, meeting?.time || null, meeting?.location || null
        );
        console.log('[NEW][' + analysis.priority + '] ' + contact + ': ' + analysis.task);
      }
    }, delay);

  } catch(e) {
    console.error('Error webhook:', e.message);
  }
});

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/tasks', (req, res) => {
  const tasks = db.prepare(`
    SELECT *, CAST((julianday('now') - julianday(created_at)) * 24 AS INTEGER) as hours
    FROM tasks WHERE status='pending'
    ORDER BY CASE priority WHEN 'ahora' THEN 0 WHEN 'hoy' THEN 1 ELSE 2 END, created_at ASC
  `).all();
  res.json(tasks.map(t => ({
    id: t.id, contact: t.contact,
    preview: t.key_message || t.preview,
    task: t.task, priority: t.priority,
    urgent: t.urgent === 1, category: t.category,
    meeting: t.meeting_time ? { date: t.meeting_date, time: t.meeting_time, location: t.meeting_location } : null,
    hours: t.hours || 0, createdAt: t.created_at,
  })));
});

app.get('/history', (req, res) => {
  const tasks = db.prepare(`
    SELECT * FROM tasks WHERE status='resolved' ORDER BY resolved_at DESC LIMIT 100
  `).all();
  res.json(tasks);
});

app.delete('/tasks/:id', (req, res) => {
  db.prepare("UPDATE tasks SET status='resolved', resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  res.sendStatus(200);
});

app.patch('/tasks/:id/snooze', (req, res) => {
  db.prepare("UPDATE tasks SET priority='semana', urgent=0 WHERE id=?").run(req.params.id);
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='pending'").get();
  res.json({ status: 'ok', pendingTasks: count.n, pendingGroups: Object.keys(messageGroups).length });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v3.1 en puerto', process.env.PORT || 3001));
