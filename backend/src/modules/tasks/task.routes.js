// Router Express de tareas. Mantiene exactamente los mismos paths y métodos.
const express = require('express');

function createTaskRoutes({ taskController }) {
  const router = express.Router();

  router.get('/tasks', taskController.list);
  router.get('/whatsapp-inbox', taskController.inbox);
  router.delete('/tasks/:id', taskController.remove);
  router.patch('/tasks/:id/snooze', taskController.snooze);
  router.patch('/tasks/:id/postpone', taskController.postpone);
  router.patch('/tasks/:id/keep', taskController.keep);
  router.patch('/tasks/:id/edit', taskController.edit);
  router.patch('/tasks/:id/feedback', taskController.feedback);
  router.patch('/tasks/:id/confirm', taskController.confirm);
  router.patch('/tasks/:id/discard', taskController.discard);
  router.patch('/tasks/:id/no-action', taskController.noAction);

  return router;
}

module.exports = { createTaskRoutes };
