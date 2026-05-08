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

// Filtros: ignorar estos tipos de mensajes
function shouldIgnore(contact, text) {
  // Ignorar IDs de grupos raros
  if (contact.includes('@g.us') || contact.includes('@lid')) return true;
  if (contact === 'status@broadcast') return true;
  
  // Ignorar publicidad y spam de eventos
  const spamPatterns = [
    /vendo/i, /compro/i, /venta/i, /precio/i,
    /entradas/i, /tickets/i, /boleteria/i, /festival/i,
    /after party/i, /dj /i, /line up/i, /lineup/i,
    /punto de venta/i, /palco/i, /vip/i,
    /descuento/i, /promo/i, /oferta/i,
    /envios en el dia/i, /delivery/i,
    /\*COMPRO\*/i, /\*VENDO\*/i,
    /click aca/i, /haciendo click/i,
    /www\./i, /http/i,
  ];
  
  // Si el texto tiene patron de spam, ignorar
  const spamCount = spamPatterns.filter(p => p.test(text)).length;
  if (spamCount >= 2) return true;
  
  // Ignorar mensajes muy cortos sin contexto (emojis solos, etc)
  if (text.length < 3) return true;
  
  return false;
}

async function analyzeMessage(contact, text) {
  const res = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{
      role: 'user',
      content: `Sos un asistente personal. Analizá este mensaje de WhatsApp y decidí si requiere una acción de mi parte.
      
IGNORAR si es: publicidad, spam, noticias de grupos, venta de entradas/tickets, compra/venta de productos, mensajes de broadcast, cadenas.
SOLO marcar como pendiente si: alguien me hace una pregunta directa, me pide algo concreto, me confirma una reunión, o necesita respuesta urgente de mi parte.

Contacto: ${contact}
Mensaje: ${text}

Respondé SOLO en JSON:
{"needsAction": true/false, "task": "qué tengo que hacer (máx 10 palabras)", "urgent": true/false}
Si no requiere acción, needsAction debe ser false.`
    }],
    max_tokens: 150,
  });
  
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch(e) {
    return { needsAction: false, task: '', urgent: false };
  }
}

app.post('/webhook', async (req, res) => {
  try {
    const { event, payload } = req.body;
    if (event !== 'message') return res.sendStatus(200);
    if (payload.fromMe) return res.sendStatus(200);

    const text = payload.body || '';
    const contact = payload._data?.notifyName || payload.from || '';
    
    // Filtrar antes de llamar a la IA
    if (shouldIgnore(contact, text)) return res.sendStatus(200);
    if (!text || text.length < 3) return res.sendStatus(200);

    const analysis = await analyzeMessage(contact, text);

    if (analysis.needsAction) {
      tasks.push({
        id: Date.now(),
        contact,
        preview: text.slice(0, 80),
        task: analysis.task,
        urgent: analysis.urgent,
        hours: 0,
        createdAt: new Date(),
      });
      console.log('Tarea agregada:', contact, '-', analysis.task);
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
