require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const app = express();
app.use(express.json());

// CORS - allow all origins
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
      content: `Analizá este mensaje de WhatsApp y respondé SOLO en JSON sin texto extra.
Contacto: ${contact}
Mensaje: ${text}
Formato exacto:
{"needsAction": true/false, "isUnanswered": true/false, "task": "descripción corta", "urgent": true/false}`
    }],
    max_tokens: 200,
  });
  return JSON.parse(res.choices[0].message.content);
}

app.post('/webhook', async (req, res) => {
  try {
    const { event, payload } = req.body;
    if (event !== 'message') return res.sendStatus(200);
    if (payload.fromMe) return res.sendStatus(200);
    const text = payload.body || '';
    if (!text) return res.sendStatus(200);
    const contact = payload._data?.notifyName || payload.from;
    const analysis = await analyzeMessage(contact, text);
    if (analysis.needsAction || analysis.isUnanswered) {
      tasks.push({
        id: Date.now(),
        contact,
        preview: text.slice(0, 80),
        task: analysis.task,
        urgent: analysis.urgent,
        hours: 0,
        createdAt: new Date(),
      });
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
