// Transforma una fila SQLite de `tasks` al objeto JSON que consume el frontend.
// Idéntico al map que estaba inline en GET /tasks.
function toTaskDTO(t) {
  return {
    id: t.id, contact: t.contact,
    preview: t.key_message || t.preview,
    task: t.task, priority: t.priority,
    urgent: t.urgent === 1, category: t.category, company: t.company || null, type: t.type, fromMe: t.from_me === 1,
    meeting: t.meeting_date || t.meeting_time ? { date: t.meeting_date, time: t.meeting_time, location: t.meeting_location } : null,
    actions: t.actions ? (() => { try { return JSON.parse(t.actions); } catch (e) { return []; } })() : [],
    phone: t.phone || null, dueDate: t.due_date || null,
    hours: t.hours || 0, createdAt: t.created_at,
  };
}

module.exports = { toTaskDTO };
