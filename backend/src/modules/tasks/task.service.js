// Lógica de negocio de tareas. NO contiene SQL directo: usa task.repository.
// Se construye con createTaskService(deps) para recibir las dependencias que
// viven en server.js (SSE y caches de contacto) sin acoplar módulos.
const repo = require('./task.repository');
const { toTaskDTO } = require('./task.mapper');
const { validCompany, validDate } = require('../../shared/validation');

// deps = { sseBroadcast, getCachedCompany, setCachedCompany, setCachedPhone, extractActions }
function createTaskService(deps) {
  const { sseBroadcast, getCachedCompany, setCachedCompany, setCachedPhone, extractActions } = deps;

  // ── Lectura para GET /tasks ────────────────────────────────────────────────
  function listTasks(type) {
    return repo.listPendingByType(type).map(toTaskDTO);
  }

  // ── Creación/actualización desde análisis IA (antes saveTask en server.js) ──
  function saveTask(contact, msgs, analysis, contactPhone) {
    if (!analysis.needsAction || analysis.priority === 'ignorar') return;

    const extractedActions = extractActions(msgs);
    const meeting = (analysis.meeting?.date || analysis.meeting?.time) ? analysis.meeting : null;

    // Chip de calendario: siempre presente; si la IA detectó reunión se pre-rellena fecha/hora
    if (!extractedActions.some(a => a.type === 'calendar')) {
      extractedActions.push({
        type: 'calendar',
        title: (analysis.task || '').slice(0, 60),
        date: meeting ? (meeting.date || null) : null,
        time: meeting ? (meeting.time || null) : null,
        location: meeting ? (meeting.location || null) : null,
      });
    }

    // WhatsApp: siempre usar el número del contacto de WAHA (payload.from), no el del texto
    for (let i = extractedActions.length - 1; i >= 0; i--) {
      if (extractedActions[i].type === 'whatsapp') extractedActions.splice(i, 1);
    }
    if (contactPhone && !extractedActions.some(a => a.type === 'whatsapp_contact')) {
      extractedActions.unshift({ type: 'whatsapp_contact', value: contactPhone.replace(/\D/g, ''), label: 'WhatsApp' });
    }

    const actionsJson = extractedActions.length ? JSON.stringify(extractedActions) : null;

    // Filtro de alucinación: solo aplica si NO hay meeting detectado (las reuniones ya son validadas por la IA)
    // Incluye el nombre del contacto en el espacio de búsqueda, y requiere 2+ palabras ausentes para bloquear
    if (!meeting) {
      const allText = (msgs || []).map(m => (m.text || '').toLowerCase()).join(' ') + ' ' + contact.toLowerCase();
      const generic = new Set(['responder', 'revisar', 'enviar', 'mandar', 'contactar', 'confirmar', 'llamar',
        'consultar', 'preguntar', 'contestar', 'escribir', 'seguir', 'hacer', 'tarea', 'mensaje', 'sobre',
        'para', 'cosa', 'algo', 'tema', 'reunir', 'reunion', 'asistir', 'recibir', 'verse', 'juntarse', 'hablar']);
      const meaningfulWords = (analysis.task || '').toLowerCase().split(/\s+/)
        .filter(w => w.length >= 4 && !generic.has(w));
      if (meaningfulWords.length >= 2 && !meaningfulWords.some(w => allText.includes(w))) {
        console.log('[SKIP-HALLUCINATION] ' + contact + ': "' + analysis.task + '" no matchea');
        return;
      }
    }

    const type = analysis.type || 'pendiente';
    const lastMsg = msgs[msgs.length - 1]?.text || '';
    const keyMsg = (analysis.keyMessage || lastMsg).slice(0, 150);
    const safeTask = (analysis.task || 'Revisar mensaje').slice(0, 100);
    // Empresa: el mapeo aprendido del contacto manda; sino la inferencia de la IA
    const company = getCachedCompany(contact) || validCompany(analysis.company) || null;
    const dueDate = validDate(analysis.dueDate);

    // Parámetros comunes para update/insert
    const base = {
      contact,
      preview: lastMsg.slice(0, 80),
      keyMessage: keyMsg,
      task: safeTask,
      priority: analysis.priority || 'hoy',
      urgent: analysis.urgent ? 1 : 0,
      category: analysis.category || 'personal',
      company,
      dueDate,
      type,
      fromMe: type === 'mio' ? 1 : 0,
      meetingDate: meeting?.date || null,
      meetingTime: meeting?.time || null,
      meetingLocation: meeting?.location || null,
      actions: actionsJson,
      phone: contactPhone,
    };

    if (type === 'mio') {
      const existing = repo.findPendingByContactType(contact, 'mio');
      if (existing) {
        repo.updateOnSave(existing.id, base);
        console.log('[MIO-UPDATE] ' + contact + ': ' + safeTask);
        sseBroadcast('task_changed', { type: 'updated', taskType: 'mio', contact });
        return;
      }
    } else {
      const recentList = repo.findRecentPendiente(contact);
      const genericSet = new Set(['responder', 'revisar', 'enviar', 'mandar', 'contactar', 'confirmar', 'llamar', 'consultar', 'preguntar', 'contestar', 'escribir', 'seguir', 'hacer', 'tarea', 'mensaje', 'para', 'sobre', 'cosa', 'algo', 'tema', 'obtener', 'recibir']);
      const newWords = safeTask.toLowerCase().split(/\s+/).filter(w => w.length >= 4 && !genericSet.has(w));
      let matchedExisting = null;
      for (const r of recentList) {
        const oldWords = (r.task || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4 && !genericSet.has(w));
        if (newWords.some(w => oldWords.some(o => o.includes(w) || w.includes(o)))) { matchedExisting = r; break; }
      }
      if (matchedExisting) {
        repo.updateOnSave(matchedExisting.id, base);
        console.log('[PENDIENTE-UPDATE] ' + contact + ': ' + safeTask);
        sseBroadcast('task_changed', { type: 'updated', taskType: 'pendiente', contact });
        return;
      }
    }

    // Fix: el INSERT original no incluía actions ni phone — datos se perdían en nuevas tareas
    repo.insertFull(base);
    console.log('[' + type.toUpperCase() + '-NEW][' + (analysis.priority || 'hoy') + '] ' + contact + ': ' + safeTask);
    sseBroadcast('task_changed', { type: 'new', taskType: type, contact });
  }

  // ── Operaciones de tarjeta ──────────────────────────────────────────────────
  function resolveTask(id) {
    repo.resolveById(id);
    sseBroadcast('task_changed', { type: 'resolved', id });
  }
  function snoozeTask(id) {
    repo.snoozeById(id);
    sseBroadcast('task_changed', { type: 'snoozed', id });
  }
  function postponeTask(id, due) {
    // Posponer = fijar fecha y bajar prioridad; el escalado la vuelve a subir al acercarse
    repo.postponeById(id, due);
    escalateDueDates();
    sseBroadcast('task_changed', { type: 'postponed', id });
  }
  function keepTask(id) {
    repo.keepById(id);
    sseBroadcast('task_changed', { type: 'kept', id });
  }
  // Devuelve { error, status } en caso de input inválido, o { ok:true }
  function editTask(id, body) {
    const { task, priority, phone, company, dueDate } = body;
    if (!task || typeof task !== 'string') return { error: 'task required', status: 400 };
    const trimmed = task.trim().slice(0, 200);
    if (trimmed.length < 2) return { error: 'task too short', status: 400 };

    const sets = ['task=?'], vals = [trimmed];
    if (['ahora', 'hoy', 'semana'].includes(priority)) { sets.push('priority=?'); vals.push(priority); }
    const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
    if (cleanPhone) { sets.push('phone=?'); vals.push(cleanPhone); }
    // company y dueDate: solo se tocan si vienen en el body (permite asignar o limpiar)
    const hasCompany = Object.prototype.hasOwnProperty.call(body, 'company');
    const companyVal = hasCompany ? validCompany(company) : null;
    if (hasCompany) { sets.push('company=?'); vals.push(companyVal); }
    if (dueDate !== undefined) { sets.push('due_date=?'); vals.push(dueDate ? String(dueDate).slice(0, 10) : null); }

    vals.push(id);
    repo.updateDynamic(sets, vals);

    const t = repo.getContactById(id);
    if (cleanPhone && t?.contact) setCachedPhone(t.contact, cleanPhone);
    // Aprender empresa del contacto cuando Brandon la asigna manualmente
    if (hasCompany && companyVal && t?.contact && t.contact !== 'Yo') setCachedCompany(t.contact, companyVal);

    sseBroadcast('task_changed', { type: 'edited', id });
    return { ok: true };
  }
  // Descarte con motivo (error|done): registra feedback y resuelve la tarea
  function feedbackResolve(id, reason) {
    const task = repo.getFeedbackContext(id);
    if (task) {
      repo.insertFeedback(id, task.contact, task.task, task.preview, reason);
      if (reason === 'error') {
        console.log('[FEEDBACK-ERROR] IA se equivocó: ' + task.contact + ': ' + task.task);
      }
    }
    repo.resolveById(id);
    sseBroadcast('task_changed', { type: 'resolved', id });
  }

  // ── Mantenimiento (lo llaman los schedulers de server.js) ────────────────────
  function escalateDueDates() {
    let changes = 0;
    changes += repo.escalateToUrgent();
    changes += repo.escalateToHoy();
    if (changes) {
      console.log('[ESCALATE] ' + changes + ' tareas escaladas por vencimiento');
      sseBroadcast('task_changed', { type: 'escalated' });
    }
  }
  function consolidateDuplicates() {
    const dups = repo.findDuplicateContacts();
    for (const d of dups) {
      const keep = repo.findLatestPendiente(d.contact);
      if (keep) {
        const r = repo.resolveDuplicatesExcept(d.contact, keep.id);
        if (r.changes) console.log('[CONSOLIDATE] ' + d.contact + ': ' + r.changes + ' duplicados resueltos');
      }
    }
  }

  return {
    listTasks, saveTask,
    resolveTask, snoozeTask, postponeTask, keepTask, editTask, feedbackResolve,
    escalateDueDates, consolidateDuplicates,
  };
}

module.exports = { createTaskService };
