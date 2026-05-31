// Handlers HTTP de tareas. Leen req, llaman al service y responden.
// Sin SQL ni lógica de negocio pesada.
const crypto = require('crypto');
const { parseId, validDate } = require('../../shared/validation');

function createTaskController({ taskService }) {
  // GET /tasks
  function list(req, res) {
    const type = req.query.type || 'pendiente';
    const body = taskService.listTasks(type);
    const etag = '"' + crypto.createHash('md5').update(JSON.stringify(body)).digest('hex').slice(0, 16) + '"';
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('ETag', etag).set('Cache-Control', 'no-cache').json(body);
  }

  // DELETE /tasks/:id
  function remove(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    taskService.resolveTask(id);
    res.sendStatus(200);
  }

  // PATCH /tasks/:id/snooze
  function snooze(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    taskService.snoozeTask(id);
    res.sendStatus(200);
  }

  // PATCH /tasks/:id/postpone
  function postpone(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const due = validDate((req.body || {}).dueDate);
    if (!due) return res.status(400).json({ error: 'invalid date' });
    taskService.postponeTask(id, due);
    res.sendStatus(200);
  }

  // PATCH /tasks/:id/keep
  function keep(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    taskService.keepTask(id);
    res.sendStatus(200);
  }

  // PATCH /tasks/:id/edit
  function edit(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const result = taskService.editTask(id, req.body || {});
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.sendStatus(200);
  }

  // GET /whatsapp-inbox
  function inbox(req, res) {
    const body = taskService.listInbox();
    const etag = '"' + crypto.createHash('md5').update(JSON.stringify(body)).digest('hex').slice(0, 16) + '"';
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('ETag', etag).set('Cache-Control', 'no-cache').json(body);
  }

  // PATCH /tasks/:id/confirm  → pasar a tarea real
  function confirm(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    taskService.confirmTask(id);
    res.sendStatus(200);
  }

  // PATCH /tasks/:id/discard  → descartar
  function discard(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    taskService.discardTask(id);
    res.sendStatus(200);
  }

  // PATCH /tasks/:id/no-action  → no requiere acción
  function noAction(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    taskService.noActionTask(id);
    res.sendStatus(200);
  }

  // PATCH /tasks/:id/feedback
  function feedback(req, res) {
    const id = parseInt(req.params.id);
    const { reason } = req.body || {};
    if (!id || !['error', 'done'].includes(reason)) return res.status(400).json({ error: 'invalid' });
    taskService.feedbackResolve(id, reason);
    res.sendStatus(200);
  }

  return { list, remove, snooze, postpone, keep, edit, feedback, inbox, confirm, discard, noAction };
}

module.exports = { createTaskController };
