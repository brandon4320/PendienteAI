// Constantes generales reutilizadas en el backend.
// Sin lógica: solo valores que antes estaban hardcodeados en server.js.
module.exports = {
  // Empresas (claves canónicas en DB). El front mapea a nombre y color.
  COMPANIES: ['financiera', 'serviwhite', 'tecnophos', 'adc', 'transtide', 'svn', 'personal'],
  COMPANY_NAMES: {
    financiera: 'Financiera', serviwhite: 'Serviwhite', tecnophos: 'Tecnophos',
    adc: 'ADC', transtide: 'Transtide', svn: 'SVN', personal: 'Personal',
  },

  // CORS
  ALLOWED_ORIGINS: ['https://pendienteia.vercel.app', 'http://localhost:3000'],

  // SSE
  SSE_MAX_CLIENTS: 20,
  SSE_HEARTBEAT_MS: 30000,

  // Rate limit del webhook
  WEBHOOK_RPM: 120,

  // Caches / colas
  PHONE_CACHE_TTL: 24 * 60 * 60 * 1000,
  QUEUE_DELAY_MS: 2000,

  // Modelos Groq
  // llama-3.1-8b-instant: 500k tokens/dia (free) — usado para análisis masivo de WhatsApp
  // llama-3.3-70b-versatile: 100k tokens/dia (free) — reservado para bot/commands (baja frecuencia)
  GROQ_TEXT_MODEL: 'llama-3.1-8b-instant',
  GROQ_AUDIO_MODEL: 'whisper-large-v3-turbo',

  // Número @lid de Serviwhite (self-routing del bot)
  SERVWHITE_NUMBER: '61560420573356@lid',

  // Cadencias válidas de recurrentes
  CADENCES: ['daily', 'weekly', 'monthly', 'yearly'],
};
