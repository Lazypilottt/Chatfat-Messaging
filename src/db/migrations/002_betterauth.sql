-- 002_betterauth — identity moves to Better Auth (email + password).
--
-- The column names are Better Auth's, not ours, and they are camelCase. Every
-- identifier below is therefore double-quoted: an unquoted identifier folds to
-- lowercase in Postgres, and Better Auth would then look for "emailVerified"
-- and find "emailverified". `user` is additionally a reserved word, so it must
-- be quoted everywhere it appears, forever.
--
-- These definitions were read out of the library itself (getAuthTables) rather
-- than transcribed from documentation, so they match what the adapter actually
-- queries for.

create table if not exists "user" (
  "id"            text primary key,
  "name"          text not null,
  "email"         text not null unique,
  "emailVerified" boolean not null default false,
  "image"         text,
  "createdAt"     timestamptz not null default now(),
  "updatedAt"     timestamptz not null default now()
);

create table if not exists "session" (
  "id"        text primary key,
  "expiresAt" timestamptz not null,
  "token"     text not null unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "userId"    text not null references "user"("id") on delete cascade
);
create index if not exists session_user_idx on "session"("userId");

-- Despite the name, `account` is used by the email+password flow too: it is
-- where the password hash lives, under providerId = 'credential'.
create table if not exists "account" (
  "id"                    text primary key,
  "accountId"             text not null,
  "providerId"            text not null,
  "userId"                text not null references "user"("id") on delete cascade,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz not null default now(),
  "updatedAt"             timestamptz not null default now()
);
create index if not exists account_user_idx on "account"("userId");

create table if not exists "verification" (
  "id"         text primary key,
  "identifier" text not null,
  "value"      text not null,
  "expiresAt"  timestamptz not null,
  "createdAt"  timestamptz not null default now(),
  "updatedAt"  timestamptz not null default now()
);

-- The hand-rolled scrypt tables from 001. The scrypt implementation was
-- correct — constant-time comparison, self-describing hashes, timing parity on
-- unknown usernames — but it is no longer the identity model, and leaving two
-- account tables in place would leave a real question about which one is
-- authoritative. Nothing references them: `messages.from_id` held a per-socket
-- session id, never a user id.
drop table if exists sessions;
drop table if exists users;
