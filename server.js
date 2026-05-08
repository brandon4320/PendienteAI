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

// Storage
let tasks = [];
let messageGroups = {}; // Agrupa mensajes por contacto

// ─── ANÁLISIS CON IA ──────────────────────────────────────────────────────────
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

REGLAS DE CLASIFICACIÓN:

CATEGORÍA (category):
- "trabajo": el nombre contiene transtide/financiera/cliente/proveedor/obra/empresa/ing/arq/dr o el tema es laboral (pagos, facturas, reuniones, pedidos, cotizaciones, entregas)
- "personal": amigos, familia, planes sociales, salidas

PRIORIDAD (priority):
- "ahora": reuniones/pagos/confirmaciones con hora concreta hoy, cosas que si no respondés perdés plata u oportunidad
- "hoy": clientes esperando, presupuestos pendientes, coordinaciones del día
- "semana": amigos, planes futuros, cosas que pueden esperar unos días
- "info": mensajes informativos que no requieren respuesta
- "ignorar": spam, publicidad, venta de entradas, grupos de fiestas, broadcasts

DETECCIÓN DE REUNIONES:
Si el mensaje menciona una reunión, extraé fecha y hora.

Respondé SOLO en JSON válido:
{
  "needsAction": true/false,
  "priority": "ahora|hoy|semana|info|ignorar",
  "category": "trabajo|personal",
  "task": "qué tengo que hacer en máximo 8 palabras",
  "meeting": { "date": "fecha si hay", "time": "hora si hay", "location": "lugar si hay" } o null,
  "groupSummary": "resumen si hay múltiples mensajes del mismo tema",
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
  res.sendStatus(200); // Responder rápido a WAHA

  try {
    const { event, payload } = req.body;
    if (event !== 'message') return;
    if (payload.fromMe) return;

    const text = payload.body || '';
    const contact = payload._data?.notifyName || payload.from || '';

    // Ignorar broadcasts y IDs técnicos sin nombre
    if (contact === 'status@broadcast') return;
    if (!payload._data?.notifyName && contact.includes('@')) return;
    if (!text || text.length < 3) return;

    // Agrupar mensajes del mismo contacto (ventana de 5 minutos)
    const now = Date.now();
    const groupKey = contact;
    
    if (!messageGroups[groupKey]) {
      messageGroups[groupKey] = { messages: [], timer: null, firstTime: now };
    }
    
    messageGroups[groupKey].messages.push(text);
    
    // Limpiar timer anterior
    if (messageGroups[groupKey].timer) {
      clearTimeout(messageGroups[groupKey].timer);
    }
    
    // Procesar después de 30 segundos de silencio (agrupar ráfagas)
    messageGroups[groupKey].timer = setTimeout(async () => {
      const msgs = messageGroups[groupKey].messages;
      delete messageGroups[groupKey];
      
      const analysis = await analyzeMessage(contact, msgs);
      
      if (analysis.priority === 'ignorar' || !analysis.needsAction) return;
      
      // Buscar si ya existe tarea del mismo contacto y reemplazar
      const existingIdx = tasks.findIndex(t => t.contact === contact && t.priority !== 'info');
      
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
        meeting: analysis.meeting || null,
        hours: 0,
        createdAt: new Date(),
      };
      
      if (existingIdx >= 0) {
        tasks[existingIdx] = newTask;
      } else {
        tasks.push(newTask);
      }
      
      // Ordenar por prioridad
      const order = { ahora: 0, hoy: 1, semana: 2, info: 3 };
      tasks.sort((a,b) => (order[a.priority]||2) - (order[b.priority]||2));
      
      console.log(`[${newTask.priority.toUpperCase()}][${newTask.category}] ${contact}: ${newTask.task}`);
    }, 30000); // 30 segundos de ventana

  } catch(e) {
    console.error('Error webhook:', e.message);
  }
});

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/tasks', (req, res) => {
  const withHours = tasks.map(t => ({
    ...t,
    hours: Math.floor((Date.now() - new Date(t.createdAt)) / 3600000),
  }));
  res.json(withHours);
});

app.delete('/tasks/:id', (req, res) => {
  tasks = tasks.filter(t => t.id != req.params.id);
  res.sendStatus(200);
});

app.patch('/tasks/:id/snooze', (req, res) => {
  const task = tasks.find(t => t.id == req.params.id);
  if (task) {
    task.priority = 'semana';
    task.urgent = false;
  }
  res.sendStatus(200);
});

app.get('/stats', (req, res) => {
  res.json({
    total: tasks.length,
    ahora: tasks.filter(t=>t.priority==='ahora').length,
    hoy: tasks.filter(t=>t.priority==='hoy').length,
    semana: tasks.filter(t=>t.priority==='semana').length,
    trabajo: tasks.filter(t=>t.category==='trabajo').length,
    personal: tasks.filter(t=>t.category==='personal').length,
    meetings: tasks.filter(t=>t.meeting).length,
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', tasks: tasks.length, pending: Object.keys(messageGroups).length }));

app.listen(process.env.PORT || 3001, () => {
  console.log('PendienteAI v2 corriendo en puerto', process.env.PORT || 3001);
});
