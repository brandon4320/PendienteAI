// Helpers de fecha puros (sin DB ni efectos colaterales).
// Movidos tal cual desde server.js para reutilizarlos en el motor de recurrentes.

function todayISO_AR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}
function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return toISO(d);
}
function daysInMonth(y, m0) { return new Date(y, m0 + 1, 0).getDate(); }
function addMonthsClamped(iso, n, dom) {
  const d = new Date(iso + 'T00:00:00');
  const idx = d.getMonth() + n;
  const y = d.getFullYear() + Math.floor(idx / 12);
  const m = ((idx % 12) + 12) % 12;
  const day = Math.min(Math.max(dom || d.getDate(), 1), daysInMonth(y, m));
  return toISO(new Date(y, m, day));
}
// Avanza desde la ocurrencia previa según la cadencia y el intervalo (cada N)
function advanceRunISO(rule, prevISO) {
  const n = Math.max(1, Number(rule.interval) || 1);
  const dom = Math.min(Math.max(Number(rule.day_of_month) || 1, 1), 31);
  if (rule.cadence === 'daily') return addDaysISO(prevISO, n);
  if (rule.cadence === 'weekly') return addDaysISO(prevISO, 7 * n);
  if (rule.cadence === 'monthly') return addMonthsClamped(prevISO, n, dom);
  if (rule.cadence === 'yearly') return addMonthsClamped(prevISO, 12 * n, dom);
  return addDaysISO(prevISO, n);
}
// Primera fecha (>= fromISO) que cumple la cadencia de la regla (ignora intervalo)
function computeNextRunISO(rule, fromISO) {
  let d = new Date(fromISO + 'T00:00:00');
  const cad = rule.cadence;
  if (cad === 'daily') return toISO(d);
  if (cad === 'weekly') {
    const target = ((Number(rule.day_of_week) % 7) + 7) % 7;
    for (let i = 0; i < 7; i++) { if (d.getDay() === target) return toISO(d); d.setDate(d.getDate() + 1); }
    return toISO(d);
  }
  if (cad === 'monthly') {
    const dom = Math.min(Math.max(Number(rule.day_of_month) || 1, 1), 31);
    for (let i = 0; i < 400; i++) {
      if (d.getDate() === Math.min(dom, daysInMonth(d.getFullYear(), d.getMonth()))) return toISO(d);
      d.setDate(d.getDate() + 1);
    }
    return toISO(d);
  }
  if (cad === 'yearly') {
    const mo = Math.min(Math.max(Number(rule.month) || 1, 1), 12) - 1;
    const dom = Math.min(Math.max(Number(rule.day_of_month) || 1, 1), 31);
    for (let i = 0; i < 800; i++) {
      if (d.getMonth() === mo && d.getDate() === Math.min(dom, daysInMonth(d.getFullYear(), d.getMonth()))) return toISO(d);
      d.setDate(d.getDate() + 1);
    }
    return toISO(d);
  }
  return toISO(d);
}

module.exports = {
  todayISO_AR, toISO, addDaysISO, daysInMonth, addMonthsClamped,
  advanceRunISO, computeNextRunISO,
};
