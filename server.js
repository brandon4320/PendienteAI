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

// Crear tabla si no existe
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
    meeting_date TEXT,
    meeting_time TEXT,
    meeting_location TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
  );
`);

// Migraciones seguras — agregar columnas si no existen
const existingCols = db.pragma('table_info(tasks)').map(c => c.name);
if (!existingCols.includes('type')) {
  db.exec("ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'pendiente'");
  console.log('Migración: columna type agregada');
}

// Crear índices después de la migración
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_type ON tasks(type);
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
  /cita|mañana|hoy|esta noche|esta tarde|nos vemos|te espero|a las \d|venís|vengo|paso a buscar|vení|voy para|yendo/i,
  /reunión|reunion|meeting|junta|llamada|llámame|llamame|urgente|importante|licitacion|licitación/i,
  /confirmá|confirmas|confirmame|me avisás|me avisas|podés|podes|necesito|necesitás|avisame|avísame/i,
  /cotizame|cotización|cotizacion|presupuesto|novedades|como va|cómo va|hay algo|sabés algo|sabes algo/i,
  /aduana|despacho|embarque|carga|contenedor|exolgan|terminal|packing|mercadería|mercaderia/i,
  /factura|remito|cheque|transferencia|zelle|alias|te mando|te mandé|te mande|pagaste/i,
  /salimos|vamos|te animás|te animas|quedamos|juntamos|nos juntamos|asadito|venis\?|sumas\?/i,
  /proveedor|alibaba|1688|paneles|importacion|importación|emprendimiento/i,
  /contame|me decís|me dices|mandame|pasame|necesito que/i,
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
      content: `Sos el asistente personal de Brandon. Analizá estos mensajes de WhatsApp.
Hora actual: ${timeStr}
Contacto: ${contact}

MENSAJES:
${msgList}

Brandon quiere ver TODOS los mensajes que requieran algún tipo de respuesta o acción. Él decide si está resuelto.

Identificá el mensaje MÁS IMPORTANTE. 

CATEGORÍA:
- "trabajo": transtide/financiera/cliente/proveedor/logistica/transporte/obra/aduana en nombre, o tema laboral
- "personal": amigos, familia, pareja, planes sociales

PRIORIDAD:
- "ahora": urgente, hora concreta hoy, camión/carga en movimiento
- "hoy": necesita respuesta hoy, plan para mañana, pago pendiente
- "semana": planes futuros, consultas sin urgencia
- "ignorar": solo charla pura sin ninguna acción requerida

Respondé SOLO en JSON:
{
  "needsAction": true/false,
  "priority": "ahora|hoy|semana|ignorar",
  "category": "trabajo|personal",
  "keyMessage": "el mensaje más importante (máx 70 chars)",
  "task": "qué tiene que hacer Brandon, específico, máximo 8 palabras",
  "meeting": { "date": "fecha", "time": "hora", "location": "lugar" } o null,
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

function saveTask(contact, msgs, analysis, type) {
  const meeting = analysis.meeting?.time ? analysis.meeting : null;
  const existing = db.prepare(
    "SELECT id FROM tasks WHERE contact=? AND status='pending' AND type=? LIMIT 1"
  ).get(contact, type);

  const vals = [
    msgs[msgs.length-1].slice(0,80),
    (analysis.keyMessage || msgs[msgs.length-1]).slice(0,150),
    analysis.task || 'Revisar mensaje',
    analysis.priority || 'hoy',
    analysis.urgent ? 1 : 0,
    analysis.category || 'personal',
    type,
    meeting?.date || null, meeting?.time || null, meeting?.location || null,
  ];

  if (existing) {
    db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,
      category=?,type=?,meeting_date=?,meeting_time=?,meeting_location=?,
      created_at=CURRENT_TIMESTAMP WHERE id=?`).run(...vals, existing.id);
  } else {
    db.prepare(`INSERT INTO tasks
      (preview,key_message,task,priority,urgent,category,type,meeting_date,meeting_time,meeting_location,contact)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, contact);
  }
  console.log('[' + type + '][' + (analysis.priority||'hoy') + '][' + (analysis.category||'?') + '] ' + contact + ': ' + analysis.task);
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { event, payload } = req.body;
    if (event !== 'message') return;

    const text = payload.body || '';
    const contact = payload._data?.notifyName || payload.from || '';
    const fromMe = payload.fromMe || false;

    if (contact === 'status@broadcast') return;
    if (!payload._data?.notifyName && contact.includes('@g.us')) return;
    if (!text || text.length < 3) return;

    if (!fromMe) {
      // Mensaje recibido → bandeja pendiente
      if (!messageGroups[contact]) messageGroups[contact] = { messages: [], timer: null };
      messageGroups[contact].messages.push(text);
      if (messageGroups[contact].timer) clearTimeout(messageGroups[contact].timer);

      const delay = hasUrgentKeywords(text) ? 5000 : 30000;
      messageGroups[contact].timer = setTimeout(async () => {
        const msgs = [...messageGroups[contact].messages];
        delete messageGroups[contact];

        const analysis = await analyzeMessage(contact, msgs);
        const forced = msgs.some(m => hasUrgentKeywords(m));

        if (analysis.priority === 'ignorar' && !forced) return;
        if (!analysis.needsAction && !forced) {
          if (!forced) return;
          analysis.needsAction = true;
          analysis.priority = 'hoy';
          analysis.task = 'Responder mensaje';
          analysis.keyMessage = msgs[msgs.length-1];
        }

        saveTask(contact, msgs, analysis, 'pendiente');
      }, delay);

    } else {
      // Brandon respondió → limpiar sin_responder de ese contacto
      db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE contact=? AND type='sin_responder' AND status='pending'").run(contact);
    }

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
    id: t.id, contact: t.contact,
    preview: t.key_message || t.preview,
    task: t.task, priority: t.priority,
    urgent: t.urgent === 1, category: t.category, type: t.type,
    meeting: t.meeting_time ? { date: t.meeting_date, time: t.meeting_time, location: t.meeting_location } : null,
    hours: t.hours || 0, createdAt: t.created_at,
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

app.patch('/tasks/:id/keep', (req, res) => {
  db.prepare("UPDATE tasks SET type='pendiente' WHERE id=?").run(req.params.id);
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='pending'").get();
  res.json({ status: 'ok', pendingTasks: count.n });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v4 en puerto', process.env.PORT || 3001));
