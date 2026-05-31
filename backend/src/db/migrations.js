// Creación de tablas, migraciones defensivas (ALTER), índices y normalización
// inicial. Idéntico a lo que antes corría inline en server.js al arrancar.
// Se llama una sola vez al inicio: runMigrations(db).
function runMigrations(db) {
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
      type TEXT DEFAULT 'pendiente',
      from_me INTEGER DEFAULT 0,
      meeting_date TEXT,
      meeting_time TEXT,
      meeting_location TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS conv_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact TEXT NOT NULL,
      text TEXT NOT NULL,
      from_me INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_conv_contact ON conv_history(contact, created_at);
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      contact TEXT,
      task TEXT,
      preview TEXT,
      reason TEXT, -- 'error' o 'done'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_type ON tasks(type);
    CREATE INDEX IF NOT EXISTS idx_priority ON tasks(priority);
  `);

  // Migraciones seguras
  const cols = db.pragma('table_info(tasks)').map(c => c.name);
  if (!cols.includes('type'))        db.exec("ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'pendiente'");
  if (!cols.includes('from_me'))     db.exec("ALTER TABLE tasks ADD COLUMN from_me INTEGER DEFAULT 0");
  if (!cols.includes('actions'))     db.exec("ALTER TABLE tasks ADD COLUMN actions TEXT");
  if (!cols.includes('phone'))       db.exec("ALTER TABLE tasks ADD COLUMN phone TEXT");
  if (!cols.includes('key_message')) db.exec("ALTER TABLE tasks ADD COLUMN key_message TEXT");
  if (!cols.includes('company'))     db.exec("ALTER TABLE tasks ADD COLUMN company TEXT");
  if (!cols.includes('due_date'))    db.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
  db.exec("CREATE TABLE IF NOT EXISTS contact_phones (contact TEXT PRIMARY KEY, phone TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS contact_company (contact TEXT PRIMARY KEY, company TEXT)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      company TEXT,
      priority TEXT DEFAULT 'hoy',
      category TEXT DEFAULT 'trabajo',
      cadence TEXT NOT NULL,        -- daily | weekly | monthly | yearly
      day_of_week INTEGER,          -- 0-6 (domingo=0) para weekly
      day_of_month INTEGER,         -- 1-31 para monthly/yearly
      month INTEGER,                -- 1-12 para yearly
      active INTEGER DEFAULT 1,
      next_run TEXT,                -- YYYY-MM-DD próxima fecha a generar
      last_created TEXT,            -- YYYY-MM-DD última generación (idempotencia)
      interval INTEGER DEFAULT 1,   -- cada N (días/semanas/meses/años)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const rcols = db.pragma('table_info(recurring)').map(c => c.name);
  if (!rcols.includes('interval')) db.exec("ALTER TABLE recurring ADD COLUMN interval INTEGER DEFAULT 1");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");

  // Normalización inicial: tareas sin texto
  db.prepare("UPDATE tasks SET task='Revisar mensaje' WHERE task IS NULL OR task=''").run();
}

module.exports = { runMigrations };
