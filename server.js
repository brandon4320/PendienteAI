require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── AUTENTICACIÓN ────────────────────────────────────────────────────────────
const API_TOKEN = process.env.API_TOKEN || 'pendiente2024secret';

function authMiddleware(req, res, next) {
  // El webhook de WAHA no lleva token, solo las rutas de la app
  if (req.path === '/webhook' || req.path === '/health') return next();
  const token = req.headers['x-api-token'] || req.query.token;
  if (token !== API_TOKEN) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
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
  CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_type ON tasks(type);
  CREATE INDEX IF NOT EXISTS idx_priority ON tasks(priority);
  CREATE INDEX IF NOT EXISTS idx_contact ON tasks(contact);
`);

const cols = db.pragma('table_info(tasks)').map(c => c.name);
if (!cols.includes('type')) db.exec("ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'pendiente'");
if (!cols.includes('from_me')) db.exec("ALTER TABLE tasks ADD COLUMN from_me INTEGER DEFAULT 0");

function cleanOldTasks() {
  const r = db.prepare("DELETE FROM tasks WHERE status='resolved' AND resolved_at < datetime('now','-30 days')").run();
  if (r.changes > 0) console.log('Limpieza: ' + r.changes + ' tareas');
}
cleanOldTasks();
const n3 = new Date(); n3.setHours(3,0,0,0);
if (n3 <= new Date()) n3.setDate(n3.getDate()+1);
setTimeout(()=>{cleanOldTasks();setInterval(cleanOldTasks,86400000);},n3-new Date());

// ─── COLA DE PROCESAMIENTO ────────────────────────────────────────────────────
// Evita saturar Groq (30 req/min gratis) procesando de a 1 por vez con delay
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
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
  try {
    await job();
  } catch(e) {
    console.error('Queue job error:', e.message);
  }
  // Esperar 2 segundos entre llamadas a Groq (máx 30/min = 1 cada 2s)
  setTimeout(processQueue, 2000);
}

// ─── GROQ ─────────────────────────────────────────────────────────────────────
let convBuffer = {};

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

CONVERSACIÓN:
${conv}

BUSCÁ en el CONTEXTO COMPLETO:
1. ¿Evento, cita, reunión o plan acordado entre ambos? (dale el lunes, nos vemos mañana, sino dale X)
2. ¿Tarea o pedido concreto para Brandon?
3. ¿Brandon asumió un compromiso? ("yo me ocupo", "dale el lunes", "te llamo", "ya lo cerramos")
4. ¿El último mensaje es del otro sin respuesta de Brandon?

REGLAS:
- Evento o compromiso acordado → needsAction:true, type:"mio"
- El otro le pide algo → needsAction:true, type:"pendiente"
- Brandon asumió compromiso → needsAction:true, type:"mio"
- Último mensaje del otro sin respuesta → sinResponder:true
- Charla sin acción, evento ni compromiso → needsAction:false

CATEGORÍA:
- "trabajo": nombre contiene transtide/financiera/cliente/proveedor/logistica/transporte/obra/aduana, o tema laboral
- "personal": amigos, familia, pareja, planes sociales

PRIORIDAD:
- "ahora": urgente hoy con hora concreta
- "hoy": acción necesaria hoy, plan para mañana
- "semana": evento o plan esta semana o futura
- "ignorar": charla pura sin eventos ni compromisos

Respondé SOLO JSON:
{
  "needsAction": true/false,
  "sinResponder": true/false,
  "type": "pendiente|mio",
  "priority": "ahora|hoy|semana|ignorar",
  "category": "trabajo|personal",
  "keyMessage": "mensaje más relevante (máx 70 chars)",
  "task": "qué tiene que hacer Brandon, máximo 8 palabras",
  "meeting": { "date": "día/fecha acordada", "time": "hora si hay", "location": "lugar si hay" } o null,
  "urgent": true/false
}`
    }],
    max_tokens: 350,
  });

  const content = res.choices[0].message.content.trim();
  const match = content.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : { needsAction: false, sinResponder: false, priority: 'ignorar' };
}

function saveTask(contact, msgs, analysis) {
  if (!analysis.needsAction || analysis.priority === 'ignorar') return;
  const meeting = (analysis.meeting?.date || analysis.meeting?.time) ? analysis.meeting : null;
  const type = analysis.type || 'pendiente';
  const lastMsg = msgs[msgs.length-1]?.text || '';
  const keyMsg = (analysis.keyMessage || lastMsg).slice(0, 150);

  if (type === 'mio') {
    const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='mio' LIMIT 1").get(contact);
    if (existing) {
      db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,category=?,
        meeting_date=?,meeting_time=?,meeting_location=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(lastMsg.slice(0,80),keyMsg,analysis.task,analysis.priority||'hoy',
          analysis.urgent?1:0,analysis.category||'personal',
          meeting?.date||null,meeting?.time||null,meeting?.location||null,existing.id);
      return;
    }
  }

  db.prepare(`INSERT INTO tasks (contact,preview,key_message,task,priority,urgent,category,type,from_me,meeting_date,meeting_time,meeting_location)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(contact,lastMsg.slice(0,80),keyMsg,analysis.task,analysis.priority||'hoy',
      analysis.urgent?1:0,analysis.category||'personal',type,type==='mio'?1:0,
      meeting?.date||null,meeting?.time||null,meeting?.location||null);

  console.log('['+type.toUpperCase()+']['+( analysis.priority||'hoy')+']['+( analysis.category||'?')+'] '+contact+': '+analysis.task);
}

function saveSinResponder(contact, msgs, analysis) {
  const lastMsg = msgs[msgs.length-1]?.text || '';
  const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='sin_responder' LIMIT 1").get(contact);
  if (!existing) {
    db.prepare(`INSERT INTO tasks (contact,preview,key_message,task,priority,category,type)
      VALUES (?,?,?,?,?,?,?)`)
      .run(contact,lastMsg.slice(0,80),(analysis.keyMessage||lastMsg).slice(0,150),
        'Responder a '+contact,
        analysis.priority==='ignorar'?'hoy':analysis.priority||'hoy',
        analysis.category||'personal','sin_responder');
    console.log('[SIN_RESPONDER] '+contact);
  }
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

    // Acumular conversación de AMBOS lados
    if (!convBuffer[contact]) convBuffer[contact] = { msgs: [], timer: null };
    convBuffer[contact].msgs.push({ text, fromMe });

    // Si Brandon responde → limpiar sin_responder
    if (fromMe) {
      db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE contact=? AND type='sin_responder' AND status='pending'").run(contact);
    }

    if (convBuffer[contact].timer) clearTimeout(convBuffer[contact].timer);

    // Esperar 20s de silencio, luego encolar el análisis
    convBuffer[contact].timer = setTimeout(() => {
      const msgs = [...convBuffer[contact].msgs];
      delete convBuffer[contact];

      // Agregar a la cola de procesamiento — no satura Groq
      enqueue(async () => {
        try {
          const analysis = await analyzeConversation(contact, msgs);

          if (analysis.needsAction && analysis.priority !== 'ignorar') {
            saveTask(contact, msgs, analysis);
          }
          if (analysis.sinResponder) {
            saveSinResponder(contact, msgs, analysis);
          }
        } catch(e) {
          console.error('Analysis error for ' + contact + ':', e.message);
        }
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

app.patch('/tasks/:id/keep', (req, res) => {
  db.prepare("UPDATE tasks SET type='pendiente' WHERE id=?").run(req.params.id);
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='pending'").get();
  res.json({ status:'ok', pendingTasks:count.n, queueLength:queue.length });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v5.1 en puerto', process.env.PORT || 3001));
