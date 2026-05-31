// Acceso a datos de la tabla `tasks` (y al INSERT de `feedback` usado por la
// ruta /tasks/:id/feedback). SOLO SQL: ninguna lógica de negocio.
// El SQL es idéntico al que antes estaba inline en server.js.
const db = require('../../db/connection');

// ── Lecturas ────────────────────────────────────────────────────────────────
function listPendingByType(type) {
  return db.prepare(`
    SELECT *, CAST((julianday('now')-julianday(created_at))*24 AS INTEGER) as hours
    FROM tasks WHERE status='pending' AND type=?
    ORDER BY CASE priority WHEN 'ahora' THEN 0 WHEN 'hoy' THEN 1 ELSE 2 END, created_at ASC
  `).all(type);
}
function countPending() {
  return db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='pending'").get().n;
}
function getContactById(id) {
  return db.prepare("SELECT contact FROM tasks WHERE id=?").get(id);
}
function getFeedbackContext(id) {
  return db.prepare("SELECT contact, task, preview FROM tasks WHERE id=?").get(id);
}
function findPendingByContactType(contact, type) {
  return db.prepare("SELECT id FROM tasks WHERE contact=? AND status='pending' AND type=? LIMIT 1").get(contact, type);
}
function findRecentPendiente(contact) {
  return db.prepare(`
    SELECT id, task FROM tasks
    WHERE contact=? AND status='pending' AND type='pendiente'
    AND created_at > datetime('now', '-2 hours')
    ORDER BY created_at DESC LIMIT 5
  `).all(contact);
}
function findDuplicateContacts() {
  return db.prepare(`
    SELECT contact, COUNT(*) as n FROM tasks
    WHERE status='pending' AND type='pendiente' AND contact != 'Yo'
    GROUP BY contact HAVING n > 1
  `).all();
}
function findLatestPendiente(contact) {
  return db.prepare(`
    SELECT id FROM tasks WHERE contact=? AND status='pending' AND type='pendiente'
    ORDER BY created_at DESC LIMIT 1
  `).get(contact);
}
function listPendingForDigest() {
  return db.prepare("SELECT task, company, due_date FROM tasks WHERE status='pending' AND type IN ('pendiente','mio')").all();
}
function listDueWithin(dateISO) {
  return db.prepare("SELECT task, company, due_date FROM tasks WHERE status='pending' AND type IN ('pendiente','mio') AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date ASC").all(dateISO);
}
// Listado breve para el bot (consulta "qué tengo pendiente")
function listPendingBrief() {
  return db.prepare("SELECT type, task, contact FROM tasks WHERE status='pending' ORDER BY type, created_at ASC LIMIT 10").all();
}

// ── Escrituras simples (por id) ───────────────────────────────────────────────
function resolveById(id) {
  return db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
}
function snoozeById(id) {
  return db.prepare("UPDATE tasks SET priority='semana',urgent=0 WHERE id=?").run(id);
}
function postponeById(id, due) {
  return db.prepare("UPDATE tasks SET due_date=?, priority='semana', urgent=0 WHERE id=?").run(due, id);
}
function keepById(id) {
  return db.prepare("UPDATE tasks SET type='pendiente' WHERE id=?").run(id);
}
// edit dinámico: sets es array de fragmentos "col=?" y vals incluye el id al final
function updateDynamic(sets, vals) {
  return db.prepare("UPDATE tasks SET " + sets.join(', ') + " WHERE id=?").run(...vals);
}

// ── Escrituras por contacto / mantenimiento ───────────────────────────────────
function resolveSinResponderByContact(contact) {
  return db.prepare("UPDATE tasks SET status='resolved',resolved_at=CURRENT_TIMESTAMP WHERE contact=? AND type='sin_responder' AND status='pending'").run(contact);
}
function resolveDuplicatesExcept(contact, keepId) {
  return db.prepare(`
    UPDATE tasks SET status='resolved', resolved_at=CURRENT_TIMESTAMP
    WHERE contact=? AND status='pending' AND type='pendiente' AND id != ?
  `).run(contact, keepId);
}
function deleteOldResolved() {
  return db.prepare("DELETE FROM tasks WHERE status='resolved' AND resolved_at < datetime('now','-30 days')").run();
}
function escalateToUrgent() {
  return db.prepare(`UPDATE tasks SET priority='ahora', urgent=1
    WHERE status='pending' AND due_date IS NOT NULL
    AND due_date <= date('now','localtime','+1 day')
    AND NOT (priority='ahora' AND urgent=1)`).run().changes;
}
function escalateToHoy() {
  return db.prepare(`UPDATE tasks SET priority='hoy'
    WHERE status='pending' AND due_date IS NOT NULL
    AND due_date <= date('now','localtime','+3 days')
    AND priority='semana'`).run().changes;
}

// ── Inserts / updates "completos" (desde análisis IA, bot, recurrentes) ────────
// p = { contact, preview, keyMessage, task, priority, urgent, category, company,
//        dueDate, type, fromMe, meetingDate, meetingTime, meetingLocation, actions, phone }
function updateOnSave(id, p) {
  return db.prepare(`UPDATE tasks SET preview=?,key_message=?,task=?,priority=?,urgent=?,category=?,company=?,due_date=?,
    meeting_date=?,meeting_time=?,meeting_location=?,actions=?,phone=?,created_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(p.preview, p.keyMessage, p.task, p.priority, p.urgent, p.category, p.company, p.dueDate,
      p.meetingDate, p.meetingTime, p.meetingLocation, p.actions, p.phone, id);
}
function insertFull(p) {
  return db.prepare(`INSERT INTO tasks
    (contact,preview,key_message,task,priority,urgent,category,company,due_date,type,from_me,
     meeting_date,meeting_time,meeting_location,actions,phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.contact, p.preview, p.keyMessage, p.task, p.priority, p.urgent, p.category, p.company, p.dueDate, p.type, p.fromMe,
      p.meetingDate, p.meetingTime, p.meetingLocation, p.actions, p.phone);
}
// Sin responder: type fijo 'sin_responder'
function insertSinResponder(p) {
  return db.prepare("INSERT INTO tasks (contact,preview,key_message,task,priority,category,company,type,phone,actions) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(p.contact, p.preview, p.keyMessage, p.task, p.priority, p.category, p.company, 'sin_responder', p.phone, p.actions);
}
// Recurrente: contact 'Yo', type 'pendiente', from_me 1
function insertRecurringTask(p) {
  return db.prepare(`INSERT INTO tasks (contact,preview,key_message,task,priority,category,company,due_date,type,from_me)
    VALUES ('Yo',?,?,?,?,?,?,?,'pendiente',1)`)
    .run(p.preview, p.keyMessage, p.task, p.priority, p.category, p.company, p.dueDate);
}
// Bot / quick-add: urgent 0, from_me 1
function insertBotTask(p) {
  return db.prepare('INSERT INTO tasks (contact,preview,key_message,task,priority,urgent,category,company,due_date,type,from_me,meeting_date,meeting_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(p.contact, p.preview, p.keyMessage, p.task, p.priority, 0, p.category, p.company, p.dueDate, p.type, 1, p.meetingDate, p.meetingTime);
}

// ── Feedback (tabla feedback; usada por la ruta /tasks/:id/feedback) ──────────
function insertFeedback(taskId, contact, task, preview, reason) {
  return db.prepare("INSERT INTO feedback (task_id, contact, task, preview, reason) VALUES (?,?,?,?,?)")
    .run(taskId, contact, task, preview, reason);
}

module.exports = {
  listPendingByType, countPending, getContactById, getFeedbackContext,
  findPendingByContactType, findRecentPendiente, findDuplicateContacts, findLatestPendiente,
  listPendingForDigest, listDueWithin, listPendingBrief,
  resolveById, snoozeById, postponeById, keepById, updateDynamic,
  resolveSinResponderByContact, resolveDuplicatesExcept, deleteOldResolved,
  escalateToUrgent, escalateToHoy,
  updateOnSave, insertFull, insertSinResponder, insertRecurringTask, insertBotTask,
  insertFeedback,
};
