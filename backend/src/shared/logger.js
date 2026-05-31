// Logger mínimo (sin librerías nuevas). Encapsula console para poder
// cambiar el destino/formato en el futuro sin tocar los call sites.
module.exports = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  debug: (...a) => { if (process.env.DEBUG) console.log(...a); },
};
