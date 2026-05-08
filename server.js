require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
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

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
let tasks = [];
let messageGroups = {};

// Palabras clave que SIEMPRE deben capturarse sin importar la categoría
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
      content: `Sos mi asistente personal de productividad. Analizá este/estos mensajes de WhatsApp.
Hora actual: ${timeStr}

CONTACTO: ${contact}
MENSAJE(S): ${msgText}

REGLAS IMPORTANTES:
- Si el mensaje menciona una cita, plan, encuentro, "mañana", "hoy", "nos vemos", hora concreta → SIEMPRE marcar needsAction:true
- Si el mensaje hace una pregunta directa → needsAction:true
- Si el contacto pide confirmación → needsAction:true
- Solo ignorar: spam masivo, publicidad, venta de entradas a desconocidos, broadcasts

CATEGORÍA:
- "trabajo": nombre con transtide/financiera/cliente/proveedor/obra o tema laboral
- "personal": pareja, amigos, familia, planes sociales

PRIORIDAD:
- "ahora": reuniones/pagos hoy con hora concreta, cosas urgentes de trabajo
- "hoy": necesita respuesta hoy, cita o plan para mañana/esta semana que confirmaste
- "semana": planes futuros, cosas sin urgencia inmediata
- "ignorar": spam, publicidad, broadcasts masivos

DETECTAR REUNIÓN: si hay fecha/hora/lugar extraé los datos.

Respondé SOLO en JSON:
{
  "needsAction": true/false,
  "priority": "ahora|hoy|semana|ignorar",
  "category": "trabajo|personal",
  "task": "qué tengo que hacer en máximo 8 palabras",
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

    const groupKey = contact;
    if (!messageGroups[groupKey]) {
      messageGroups[groupKey] = { messages: [], timer: null };
    }
    messageGroups[groupKey].messages.push(text);

    if (messageGroups[groupKey].timer) clearTimeout(messageGroups[groupKey].timer);

    // Si el mensaje tiene palabras clave urgentes, procesar en 5 seg en lugar de 30
    const delay = hasUrgentKeywords(text) ? 5000 : 30000;

    messageGroups[groupKey].timer = setTimeout(async () => {
      const msgs = messageGroups[groupKey].messages;
      delete messageGroups[groupKey];

      const analysis = await analyzeMessage(contact, msgs);

      // Si tiene palabras urgentes y la IA dijo ignorar, igual capturar
      const forcedCapture = msgs.some(m => hasUrgentKeywords(m));
      if (analysis.priority === 'ignorar' && !forcedCapture) return;
      if (!analysis.needsAction && !forcedCapture) return;

      // Si fue forzado por keywords, ajustar prioridad mínima a "hoy"
      if (forcedCapture && (!analysis.needsAction || analysis.priority === 'ignorar')) {
        analysis.needsAction = true;
        analysis.priority = 'hoy';
        analysis.task = analysis.task || 'Responder mensaje importante';
      }

      const existingIdx = tasks.findIndex(t => t.contact === contact);
      const newTask = {
        id: Date.now(),
        contact,
        preview: msgs[msgs.length - 1].slice(0, 80),
        fullPreview: msgs.join(' | ').slice(0, 200),
        msgCount: msgs.length,
        task: analysis.task,
        priority: analysis.priority || 'hoy',
        urgent: analysis.urgent || analysis.priority === 'ahora',
        category: analysis.category || 'personal',
        meeting: analysis.meeting?.time ? analysis.meeting : null,
        hours: 0,
        createdAt: new Date(),
      };

      if (existingIdx >= 0) {
        tasks[existingIdx] = newTask;
      } else {
        tasks.push(newTask);
      }

      const order = { ahora: 0, hoy: 1, semana: 2 };
      tasks.sort((a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2));

      console.log(`[${newTask.priority.toUpperCase()}][${newTask.category}] ${contact}: ${newTask.task}`);
    }, delay);

  } catch(e) {
    console.error('Error:', e.message);
  }
});

app.get('/tasks', (req, res) => {
  res.json(tasks.map(t => ({ ...t, hours: Math.floor((Date.now() - new Date(t.createdAt)) / 3600000) })));
});

app.delete('/tasks/:id', (req, res) => {
  tasks = tasks.filter(t => t.id != req.params.id);
  res.sendStatus(200);
});

app.patch('/tasks/:id/snooze', (req, res) => {
  const t = tasks.find(t => t.id == req.params.id);
  if (t) { t.priority = 'semana'; t.urgent = false; }
  res.sendStatus(200);
});

app.get('/health', (req, res) => res.json({ status: 'ok', tasks: tasks.length }));

app.listen(process.env.PORT || 3001, () => console.log('PendienteAI v2.1 en puerto', process.env.PORT || 3001));
