// Centraliza la lectura de variables de entorno.
// Carga .env desde la raíz del proyecto (un nivel arriba de backend/).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

module.exports = {
  PORT: process.env.PORT || 3001,
  API_TOKEN: process.env.API_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  // OJO: WAHA_API_KEY se expone CRUDA (sin default). El webhook y la
  // transcripción dependen de que sea undefined si no está configurada;
  // sendWAMessage es el único que aplica un default ('pendiente2024').
  WAHA_API_KEY: process.env.WAHA_API_KEY,
  WAHA_URL: process.env.WAHA_URL || 'http://localhost:3000',
  WAHA_SESSION: process.env.WAHA_SESSION || 'default',
  MY_WA_NUMBER: process.env.MY_WA_NUMBER || '17542365652@c.us',
};
