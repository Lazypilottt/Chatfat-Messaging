// src/logger.js — one prefixed logger, so there is exactly one seam between
// this program and stdout. Nothing here ever prints message text or a
// ciphertext envelope; the crypto suite captures stdout and asserts it.
'use strict';

const PREFIX = '[ChatFat]';

const stamp = () => new Date().toISOString().slice(11, 19);

module.exports = {
  info: (...a) => console.log(PREFIX, stamp(), ...a),
  warn: (...a) => console.warn(PREFIX, stamp(), 'warn:', ...a),
  error: (...a) => console.error(PREFIX, stamp(), 'error:', ...a),
  raw: (...a) => console.log(...a),
};
