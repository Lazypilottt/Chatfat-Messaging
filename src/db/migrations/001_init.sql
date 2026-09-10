-- 001_init — the Lab 2 schema, formalised as migration 1.
--
-- This is the state the application shipped with before Lab 4. It is written
-- out verbatim rather than folded into a later migration so the schema's
-- history is legible: a reader can see what existed, and every change after
-- this point is a numbered, dated decision rather than a diff against nothing.
--
-- `users` and `sessions` are dropped in 003 when Better Auth takes over
-- identity. They are created here because a database that has never seen this
-- application must be able to replay the whole history from empty.

create table if not exists users (
  id          serial primary key,
  name        text not null,
  name_lower  text not null unique,
  pass        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists sessions (
  token      text primary key,
  user_id    integer not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists sessions_user on sessions(user_id);

create table if not exists rooms (
  id         text primary key,
  name       text not null,
  created_at bigint,
  created_by text,
  permanent  boolean not null default false,
  locked     boolean not null default false,
  kdf        jsonb,
  verifier   text,
  key_epoch  integer not null default 0,
  locked_by  text,
  locked_at  bigint
);

create table if not exists messages (
  id         text primary key,
  room_id    text not null,
  ts         bigint not null,
  from_name  text,
  from_id    text,
  colour     integer,
  text       text not null default '',
  action     boolean not null default false,
  reply_to   jsonb,
  mentions   jsonb,
  reactions  jsonb,
  edited_at  bigint,
  unsent     boolean not null default false,
  expires_at bigint,
  enc_alg    text,
  enc_kid    integer,
  enc_n      text,
  enc_iv     text,
  enc_ct     text,
  enc_aadv   integer
);

-- Keyset pagination reads this index backwards: (room_id, ts desc, id desc).
-- `id` is in the key because two messages can share a millisecond, and a
-- cursor that cannot break that tie will either skip a row or repeat one.
create index if not exists messages_room_ts on messages(room_id, ts desc, id desc);
