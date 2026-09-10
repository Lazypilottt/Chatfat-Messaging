// src/auth/betterauth.js — the identity provider.
//
// Email and password, not a social provider. OAuth would have made a working
// demo depend on a domain name and a TLS certificate for the deployed host —
// Google refuses non-HTTPS redirect URIs for every origin but localhost — and
// none of that bears on any of the six things the lab grades. The cost, stated
// plainly in the report: password hashes are ours again, and there is no email
// verification step.
//
// `better-auth` is ESM-first, but Node 22.12+ can require() an ESM graph with
// no top-level await, and this one has none. Verified on Node 24 before any of
// this was written — see D5 in docs/ROADMAP.md.
'use strict';

const config = require('../config');
const log = require('../logger');

let instance = null;

// Built lazily. Constructing it reaches for a database pool, and the no-database
// and memory paths must never touch one.
function auth() {
  if (instance) return instance;
  if (!config.USE_POSTGRES) throw new Error('Better Auth requires a Postgres DATABASE_URL.');

  const { betterAuth } = require('better-auth');
  const pool = require('../db/pool');

  instance = betterAuth({
    database: pool.getPool(),
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    basePath: '/api/auth',

    emailAndPassword: {
      enabled: true,
      // Off, and that is a decision rather than an oversight: there is no mail
      // transport in this system, so turning it on would lock every account out
      // of a lab demo. It is recorded in docs/THREAT-MODEL.md as a known gap —
      // an address here is a label, not a verified identity.
      requireEmailVerification: false,
      minPasswordLength: config.MIN_PASSWORD,
      maxPasswordLength: config.MAX_PASSWORD,
    },

    session: {
      expiresIn: Math.floor(config.SESSION_TTL_MS / 1000),
      updateAge: 60 * 60 * 24, // refresh a session at most once a day
    },

    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        // Strict is available because nothing in this flow is a cross-site
        // redirect. It was Lax while the plan used OAuth; that constraint is
        // gone, and Strict is the stronger default.
        sameSite: 'strict',
        // Secure cookies require https. On a plain-http LAN demo the browser
        // would silently drop them and every sign-in would appear to succeed
        // and then fail — so this follows the configured origin rather than
        // being hardcoded on.
        secure: String(config.BETTER_AUTH_URL).startsWith('https://'),
      },
    },

    // Same policy the WebSocket upgrade already uses: with no explicit list,
    // trust the origin the browser actually dialled. This server is reached at
    // whatever LAN address the demo machine has — hardcoding baseURL would
    // reject every client that did not type "localhost", which on a four
    // machine lab LAN is all of them.
    trustedOrigins: (request) => {
      if (config.ALLOWED_ORIGINS.length) return config.ALLOWED_ORIGINS;
      if (!request) return [];
      const host = request.headers.get('host');
      if (!host) return [];
      const scheme = String(config.BETTER_AUTH_URL).startsWith('https://') ? 'https' : 'http';
      return [`${scheme}://${host}`];
    },
  });

  return instance;
}

// Resolve a session from raw node request headers. Returns
// { id, name, email } or null — never throws, because an unreadable session is
// an anonymous request, not a server error.
async function sessionFromHeaders(headers) {
  try {
    const { fromNodeHeaders } = require('better-auth/node');
    const res = await auth().api.getSession({ headers: fromNodeHeaders(headers) });
    if (!res || !res.user) return null;
    return { id: String(res.user.id), name: res.user.name || res.user.email, email: res.user.email };
  } catch (err) {
    log.warn('session lookup failed:', err.message);
    return null;
  }
}

module.exports = { auth, sessionFromHeaders };
