require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── BASE DE DATOS SQLITE ────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'tasks.db'));

// Crear tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact TEXT NOT NULL,
    preview TEXT,
    full_preview TEXT,
    msg_count INTEGER DEFAULT 1,
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

// Limpiar tareas resueltas con más de 30 días (ejecutar al inicio y cada noche)
function cleanOldTasks() {
  const result = db.prepare(`
    DELETE FROM tasks 
    WHERE status = 'resolved' 
    AND resolved_at < datetime('now', '-30 days')
  `).run();
  if (result.changes > 0) console.log(`Limpieza: ${result.changes} tareas eliminadas`);
}

cleanOldTasks();

// Programar limpieza diaria a las 3am
function scheduleDailyClean() {
  const now = new Date();
  const next3am = new Date();
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
  const msUntil3am = next3am - now;
  setTimeout(() => {
    cleanOldTasks();
    setInterval(cleanOldTasks, 24 * 60 * 60 * 1000);
  }, msUntil3am);
}
scheduleDailyClean();

// ─── GROQ ────────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
let messageGroups = {};

const ALWAYS_CAPTURE = [
  /cita|mañana|hoy|esta noche|esta tarde|nos vemos|te espero|a las|venís|vengo|paso a buscar/i,
  /reunión|meeting|junta|llamada|llámame|llamame|urgente|importante/i,
  /confirmá|confirmame|me avisás|me avisas|podés|podes/i,
];

function hasUrgentKeywords(text) {
  return ALWAYS_CAPTURE.some(r => r.test(text));
}

async function analyzeMessage(contact, messages) {
  const msgText = Array.isArray(messages) ? messages.join(' | ') : messages;
  const now = new Date();
  const timeStr = now.toLocaleString('es-AR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });

  const res = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{
      role: 'user',
      content: `Sos mi asistente personal. Analizá este/estos mensajes de WhatsApp.
Hora actual: ${timeStr}

CONTACTO: ${contact}
MENSAJE(S): ${msgText}

REGLAS:
- Si menciona cita, plan, "mañana", "nos vemos", hora concreta → needsAction:true
- Si hace pregunta directa o pide confirmación → needsAction:true
- Solo ignorar: spam masivo, publicidad, venta de entradas, broadcasts

CATEGORÍA:
- "trabajo": transtide/financiera/cliente/proveedor/obra en nombre, o tema laboral
- "personal": pareja, amigos, familia

PRIORIDAD:
- "ahora": urgente hoy con hora concreta
- "hoy": necesita respuesta hoy o cita para mañana
- "semana": planes futuros sin urgencia
- "ignorar": spam, publicidad

Respondé SOLO en JSON:
{
  "needsAction": true/false,
  "priority": "ahora|hoy|semana|ignorar",
  "category": "trabajo|personal",
  "task": "qué hacer en máximo 8 palabras",
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

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
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

    // Agrupar mensajes del mismo contacto
    if (!messageGroups[contact]) messageGroups[contact] = { messages: [], timer: null };
    messageGroups[contact].messages.push(text);
    if (messageGroups[contact].timer) clearTimeout(messageGroups[contact].timer);

    const delay = hasUrgentKeywords(text) ? 5000 : 30000;

    messageGroups[contact].timer = setTimeout(async () => {
      const msgs = messageGroups[contact].messages;
      delete messageGroups[contact];

      const analysis = await analyzeMessage(contact, msgs);
      const forcedCapture = msgs.some(m => hasUrgentKeywords(m));

      if (analysis.priority === 'ignorar' && !forcedCapture) return;
      if (!analysis.needsAction && !forcedCapture) return;

      if (forcedCapture && !analysis.needsAction) {
        analysis.needsAction = true;
        analysis.priority = analysis.priority === 'ignorar' ? 'hoy' : analysis.priority;
        analysis.task = analysis.task || 'Responder mensaje importante';
      }

      // Buscar si ya existe tarea pendiente del mismo contacto y actualizar
      const existing = db.prepare(
        "SELECT id FROM tasks WHERE contact = ? AND status = 'pending' LIMIT 1"
      ).get(contact);

      const meeting = analysis.meeting?.time ? analysis.meeting : null;

      if (existing) {
        db.prepare(`
          UPDATE tasks SET
            preview = ?, full_preview = ?, msg_count = ?,
            task = ?, priority = ?, urgent = ?, category = ?,
            meeting_date = ?, meeting_time = ?, meeting_location = ?,
            created_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          msgs[msgs.length-1].slice(0,80),
          msgs.join(' | ').slice(0,200),
          msgs.length,
          analysis.task,
          analysis.priority || 'hoy',
          analysis.urgent ? 1 : 0,
          analysis.category || 'personal',
          meeting?.date || null,
          meeting?.time || null,
          meeting?.location || null,
          existing.id
        );
        console.log(`[UPDATE][${analysis.priority}] ${contact}: ${analysis.task}`);
      } else {
        db.prepare(`
          INSERT INTO tasks (contact, preview, full_preview, msg_count, task, priority, urgent, category, meeting_date, meeting_time, meeting_location)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          contact,
          msgs[msgs.length-1].slice(0,80),
          msgs.join(' | ').slice(0,200),
          msgs.length,
          analysis.task,
          analysis.priority || 'hoy',
          analysis.urgent ? 1 : 0,
          analysis.category || 'personal',
          meeting?.date || null,
          meeting?.time || null,
          meeting?.location || null
        );
        console.log(`[NEW][${analysis.priority}] ${contact}: ${analysis.task}`);
      }
    }, delay);

  } catch(e) {
    console.error('Error webhook:', e.message);
  }
});

// ─── API ─────────────────────────────────────────────────────────────────────
app.get('/tasks', (req, res) => {
  const tasks = db.prepare(`
    SELECT *, 
      CAST((julianday('now') - julianday(created_at)) * 24 AS INTEGER) as hours
    FROM tasks 
    WHERE status = 'pending'
    ORDER BY 
      CASE priority WHEN 'ahora' THEN 0 WHEN 'hoy' THEN 1 ELSE 2 END,
      created_at ASC
  `).all();

  res.json(tasks.map(t => ({
    id: t.id,
    contact: t.contact,
    preview: t.preview,
    fullPreview: t.full_preview,
    msgCount: t.msg_count,
    task: t.task,
    priority: t.priority,
    urgent: t.urgent === 1,
    category: t.category,
    meeting: t.meeting_time ? { date: t.meeting_date, time: t.meeting_time, location: t.meeting_location } : null,
    hours: t.hours || 0,
    createdAt: t.created_at,
  })));
});

app.get('/history', (req, res) => {
  const tasks = db.prepare(`
    SELECT *, 
      CAST((julianday('now') - julianday(created_at)) * 24 AS INTEGER) as hours
    FROM tasks 
    WHERE status = 'resolved'
    ORDER BY resolved_at DESC
    LIMIT 100
  `).all();
  res.json(tasks);
});

app.delete('/tasks/:id', (req, res) => {
  db.prepare("UPDATE tasks SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
  res.sendStatus(200);
});

app.patch('/tasks/:id/snooze', (req, res) => {
  db.prepare("UPDATE tasks SET priority = 'semana', urgent = 0 WHERE id = ?").run(req.params.id);
  res.sendStatus(200);
});

app.get('/stats', (req, res) => {
  const pending = db.prepare("SELECT priority, category, COUNT(*) as count FROM tasks WHERE status='pending' GROUP BY priority, category").all();
  const resolved30d = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status='resolved' AND resolved_at > datetime('now', '-30 days')").get();
  res.json({ pending, resolved30d: resolved30d.count });
});

app.get('/health', (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='pending'").get();
  res.json({ status: 'ok', pendingTasks: count.n, pendingGroups: Object.keys(messageGroups).length });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v3 (SQLite) en puerto', process.env.PORT || 3001));
