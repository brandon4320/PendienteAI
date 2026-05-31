// Conexión SQLite (better-sqlite3). Instancia compartida en todo el backend.
// El archivo tasks.db vive en la RAÍZ del proyecto (igual que antes, cuando
// server.js usaba path.join(__dirname,'tasks.db')). Desde backend/src/db/ son
// tres niveles hacia arriba.
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', '..', '..', 'tasks.db');
const db = new Database(dbPath);

module.exports = db;
