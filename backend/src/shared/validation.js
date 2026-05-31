// Validaciones genéricas de input (puras, sin DB).
const { COMPANIES } = require('../config/constants');

// Devuelve la clave canónica de empresa o null si no es válida.
function validCompany(c) {
  if (!c) return null;
  const k = String(c).toLowerCase().trim();
  return COMPANIES.includes(k) ? k : null;
}

// Valida fecha ISO YYYY-MM-DD (la que produce la IA para vencimientos).
function validDate(d) {
  if (!d) return null;
  const s = String(d).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const dt = new Date(s + 'T00:00:00');
  return isNaN(dt.getTime()) ? null : s;
}

// Mapea el mimetype del audio a una extensión que Groq/Whisper reconozca.
function audioExtFromMime(mimetype) {
  const m = (mimetype || '').toLowerCase();
  if (m.includes('webm')) return '.webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('wav')) return '.wav';
  return '.ogg';
}

// Valida que el :id de ruta sea un entero positivo.
function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = { validCompany, validDate, audioExtFromMime, parseId };
