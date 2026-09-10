// src/auth/index.js — the identity facade.
//
// Better Auth owns credentials, sessions and cookies. This module is the only
// thing the rest of the server talks to, so swapping the provider again would
// touch one file.
'use strict';

const config = require('../config');
const log = require('../logger');
const pool = require('../db/pool');
const { auth, sessionFromHeaders } = require('./betterauth');

// Display name, not identity. `sender_id` binds to the account id, so a rename
// can never reassign authorship of a past message.
async function renameUser(userId, name) {
  if (!config.USE_POSTGRES) return false;
  try {
    const res = await pool.query('update "user" set "name" = $1, "updatedAt" = now() where "id" = $2', [name, userId]);
    return res.rowCount > 0;
  } catch (err) {
    log.error('rename failed:', err.message);
    return false;
  }
}

function checkCredentials(email, password) {
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return { code: 'NAME_INVALID', message: 'That does not look like an email address.' };
  }
  if (typeof password !== 'string' || password.length < config.MIN_PASSWORD || password.length > config.MAX_PASSWORD) {
    return {
      code: 'WEAK_PASSWORD',
      message: `Passwords are ${config.MIN_PASSWORD}–${config.MAX_PASSWORD} characters.`,
    };
  }
  return null;
}

module.exports = { auth, sessionFromHeaders, renameUser, checkCredentials };
