// tools/keygen.js — prints a random MASTER_KEY: 32 bytes, base64, exactly
// what src/crypto/atRest.js needs for AES-256-GCM. Referenced by
// .env.example and README.md.
//
//   node tools/keygen.js
'use strict';

const crypto = require('node:crypto');

console.log(crypto.randomBytes(32).toString('base64'));
