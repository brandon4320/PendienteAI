require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
let tasks = [];

async function analyzeMessage(contact, text) {
  const res = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{
      role: 'user',
      content: `Sos mi asistente personal. Analizá este mensaje de WhatsApp.

NOMBRE DEL CONTACTO: ${contact}
MENSAJE: ${text}

INSTRUCCIONES:
1. Usá el nombre del contacto para inferir la categoría:
   - Si el nombre contiene palabras como "transtide", "financiera", "cliente", "proveedor", "obra", "empresa", "ing", "arq", "dr", "lic", o parece un nombre de empresa → categoría TRABAJO
   - Si es un nombre de persona sin apellido o apodo → analizá el mensaje para decidir
   - Si el mensaje habla de pagos, facturas, presupuestos, reuniones de trabajo, entregas, importaciones → TRABAJO
   - Si habla de planes sociales, salidas, fiestas, familia, amigos → PERSONAL

2. Decidí si REQUIERE ACCIÓN de mi parte:
   - SÍ requiere acción: preguntas directas, pedidos concretos, confirmaciones pendientes, temas urgentes de trabajo
   - NO requiere acción: mensajes informativos, saludos, respuestas que no necesitan reply, spam, publicidad, venta de entradas

3. Respondé SOLO en JSON válido, sin texto extra:
{
  "needsAction": true/false,
  "task": "qué tengo que hacer en máximo 8 palabras",
  "urgent": true/false,
  "category": "trabajo" o "personal",
  "reason": "por qué lo clasificaste así en 5 palabras"
}`
    }],
    max_tokens: 200,
  });

  try {
    const content = res.choices[0].message.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { needsAction: false };
  } catch(e) {
    return { needsAction: false };
  }
}

app.post('/webhook', async (req, res) => {
  try {
    const { event, payload } = req.body;
    if (event !== 'message') return res.sendStatus(200);
    if (payload.fromMe) return res.sendStatus(200);

    const text = payload.body || '';
    const contact = payload._data?.notifyName || payload.from || '';

    // Ignorar IDs técnicos y broadcasts
    if (!text || text.length < 3) return res.sendStatus(200);
    if (contact.includes('@g.us') && !payload._data?.notifyName) return res.sendStatus(200);
    if (contact === 'status@broadcast') return res.sendStatus(200);

    const analysis = await analyzeMessage(contact, text);

    if (analysis.needsAction) {
      tasks.push({
        id: Date.now(),
        contact,
        preview: text.slice(0, 80),
        task: analysis.task,
        urgent: analysis.urgent,
        category: analysis.category || 'personal',
        reason: analysis.reason || '',
        hours: 0,
        createdAt: new Date(),
      });
      console.log(`[${analysis.category?.toUpperCase()}] ${contact}: ${analysis.task}`);
    }
  } catch(e) {
    console.error('Error:', e.message);
  }
  res.sendStatus(200);
});

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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3001, () => {
  console.log('PendienteAI corriendo en puerto', process.env.PORT || 3001);
});
