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

// Migraciones seguras
const cols = db.pragma('table_info(tasks)').map(c => c.name);
if (!cols.includes('type')) { db.exec("ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'pendiente'"); }
if (!cols.includes('from_me')) { db.exec("ALTER TABLE tasks ADD COLUMN from_me INTEGER DEFAULT 0"); }

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_type ON tasks(type);
  CREATE INDEX IF NOT EXISTS idx_priority ON tasks(priority);
  CREATE INDEX IF NOT EXISTS idx_contact ON tasks(contact);
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

// Buffer de conversación: guarda últimos mensajes de AMBOS lados por contacto
let convBuffer = {}; // { contact: { msgs: [{text, fromMe}], timer } }

// Keywords que disparan captura en mensajes RECIBIDOS
const CAPTURE_RECEIVED = [
  /cita|esta noche|esta tarde|nos vemos|te espero|a las \d|venís|vengo|paso a buscar|vení/i,
  /reunión|reunion|meeting|junta|llamada|llámame|llamame|urgente|importante|licitacion|licitación/i,
  /confirmá|confirmas|confirmame|me avisás|me avisas|podés|podes|necesito|necesitás|avisame|avísame/i,
  /cotizame|cotización|cotizacion|presupuesto|novedades|como va|cómo va|hay algo|sabés algo/i,
  /aduana|despacho|embarque|carga|contenedor|exolgan|terminal|packing|mercadería|mercaderia/i,
  /factura|remito|cheque|transferencia|zelle|alias|te mando|te mandé|te mande/i,
  /salimos|vamos|te animás|te animas|quedamos|juntamos|nos juntamos|asadito|venis\?|sumas\?/i,
  /proveedor|alibaba|1688|paneles|importacion|importación/i,
  /contame|me decís|me dices|mandame|pasame|necesito que/i,
  // Palabras que indican acuerdo/plan coordinado
  /el lunes|el martes|el miércoles|el jueves|el viernes|el sábado|el domingo/i,
  /mañana|esta semana|la semana que viene|la próxima semana/i,
];

// Keywords para MIS mensajes que crean compromisos
const CAPTURE_MY = [
  /dale.{0,15}(nos vemos|ahí estoy|voy|me anoto|caigo|me copa|sumo|arranco|lunes|martes|miércoles|jueves|viernes)/i,
  /nos vemos.{0,20}(mañana|hoy|lunes|martes|miércoles|jueves|viernes|sábado|domingo|d)/i,
  /cenamos|almorzamos|juntamos.{0,20}(mañana|hoy|d)/i,
  /me ocupo|yo me ocupo|lo hago|lo gestiono|te llamo|te mando|te confirmo|te aviso/i,
  /quedamos.{0,20}(mañana|hoy|lunes|martes|miércoles|jueves|viernes|d)/i,
  /paso a buscar|paso por|paso mañana/i,
  /dale (el )?(lunes|martes|miércoles|jueves|viernes|sábado|domingo)/i,
  /si te queda.{0,20}cerramos|ya lo cerramos/i,
];

// Keywords que indican ACUERDO en la conversación (independiente de quién habló último)
const EVENT_AGREED = [
  /dale (el )?(lunes|martes|miércoles|jueves|viernes|sábado|domingo)/i,
  /dale (mañana|hoy|esta noche)/i,
  /quedamos (el )?(lunes|martes|miércoles|jueves|viernes|sábado)/i,
  /nos vemos (el )?(lunes|martes|miércoles|jueves|viernes|sábado|mañana)/i,
  /confirmado|de una|va a ser el|arrancamos el|a las \d{1,2}(:\d{2})? (hs|am|pm)/i,
  /sino dale (lunes|martes|miércoles|jueves|viernes|mañana|hoy)/i,
];

function hasCapture(text, patterns) {
  return patterns.some(r => r.test(text));
}

function hasEventAgreed(messages) {
  return messages.some(m => EVENT_AGREED.some(r => r.test(m.text)));
}

async function analyzeConversation(contact, messages) {
  const now = new Date();
  const timeStr = now.toLocaleString('es-AR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });

  // Formatear conversación mostrando quién habla
  const conv = messages.map((m, i) =>
    (i+1) + '. [' + (m.fromMe ? 'BRANDON' : contact) + ']: ' + m.text
  ).join('\n');

  const res = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{
      role: 'user',
      content: `Sos el asistente personal de Brandon. Analizá esta conversación de WhatsApp.
Hora actual: ${timeStr}
Contacto: ${contact}

CONVERSACIÓN COMPLETA (ambos lados):
${conv}

IMPORTANTE: Analizá el CONTEXTO COMPLETO de la conversación, no solo el último mensaje.
Buscá:
1. ¿Quedó algún evento, reunión, cita o plan coordinado? (aunque Brandon haya mandado el último mensaje)
2. ¿Hay alguna acción pendiente de Brandon? (responder, confirmar, llamar, pagar, enviar algo)
3. ¿Brandon asumió algún compromiso? ("yo me ocupo", "te llamo", "dale el lunes")

CATEGORÍA:
- "trabajo": nombre contiene transtide/financiera/cliente/proveedor/logistica/transporte/obra/aduana, o tema laboral
- "personal": amigos, familia, pareja, planes sociales

PRIORIDAD:
- "ahora": urgente con hora concreta hoy
- "hoy": acción necesaria hoy o plan para mañana
- "semana": evento o plan esta semana
- "ignorar": charla sin ningún evento ni acción pendiente

TIPO:
- "pendiente": el otro le está pidiendo algo a Brandon
- "mio": Brandon asumió un compromiso o quedó en algo

Respondé SOLO en JSON:
{
  "needsAction": true/false,
  "type": "pendiente|mio",
  "priority": "ahora|hoy|semana|ignorar",
  "category": "trabajo|personal",
  "keyMessage": "el mensaje más relevante de la conversación (máx 70 chars)",
  "task": "qué tiene que hacer Brandon, específico, máximo 8 palabras",
  "meeting": { "date": "día/fecha si se acordó algo", "time": "hora si hay", "location": "lugar si hay" } o null,
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

function saveTask(contact, msgs, analysis) {
  const meeting = analysis.meeting?.date || analysis.meeting?.time ? analysis.meeting : null;
  const type = analysis.type || 'pendiente';
  const lastMsg = msgs[msgs.length-1]?.text || '';

  // Múltiples tareas por contacto para pendiente, una por contacto para mio
  if (type === 'mio') {
    const existing = db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='mio' LIMIT 1").get(contact);
    if (existing) {
      db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,
        category=?,meeting_date=?,meeting_time=?,meeting_location=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(lastMsg.slice(0,80),(analysis.keyMessage||lastMsg).slice(0,150),
          analysis.task,analysis.priority||'hoy',analysis.urgent?1:0,analysis.category||'personal',
          meeting?.date||null,meeting?.time||null,meeting?.location||null,existing.id);
      return;
    }
  }

  db.prepare(`INSERT INTO tasks (contact,preview,key_message,task,priority,urgent,category,type,from_me,meeting_date,meeting_time,meeting_location)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(contact,lastMsg.slice(0,80),(analysis.keyMessage||lastMsg).slice(0,150),
      analysis.task,analysis.priority||'hoy',analysis.urgent?1:0,analysis.category||'personal',
      type,type==='mio'?1:0,meeting?.date||null,meeting?.time||null,meeting?.location||null);

  console.log('[' + type.toUpperCase() + '][' + (analysis.priority||'hoy') + '][' + (analysis.category||'?') + '] ' + contact + ': ' + analysis.task);
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

    // Limpiar conversaciones viejas (> 5 minutos sin actividad)
    if (convBuffer[contact].timer) clearTimeout(convBuffer[contact].timer);

    // Determinar si hay algo que capturar
    const shouldCapture = (!fromMe && hasCapture(text, CAPTURE_RECEIVED))
      || (fromMe && hasCapture(text, CAPTURE_MY))
      || hasEventAgreed(convBuffer[contact].msgs);

    if (!shouldCapture) {
      // Resetear buffer después de 5 minutos de silencio si no hay nada relevante
      convBuffer[contact].timer = setTimeout(() => { delete convBuffer[contact]; }, 300000);
      return;
    }

    // Esperar 15 segundos para acumular más mensajes de la conversación
    const delay = hasEventAgreed(convBuffer[contact].msgs) ? 5000 : 15000;

    convBuffer[contact].timer = setTimeout(async () => {
      const msgs = [...convBuffer[contact].msgs];
      delete convBuffer[contact];

      const analysis = await analyzeConversation(contact, msgs);

      if (!analysis.needsAction || analysis.priority === 'ignorar') return;

      saveTask(contact, msgs, analysis);

      // Si Brandon respondió, limpiar sin_responder
      if (fromMe) {
        db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE contact=? AND type='sin_responder' AND status='pending'").run(contact);
      }
    }, delay);

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
  res.json({ status:'ok', pendingTasks:count.n });
});

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v4.2 en puerto', process.env.PORT || 3001));
