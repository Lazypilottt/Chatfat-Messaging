-- 003_at_rest — requirement 3: message text is no longer stored as plaintext.
--
-- `text` keeps its name and type but changes meaning once `text_kv` is set: it
-- holds a base64 AES-256-GCM blob (ciphertext || tag), not the message body.
-- `text_kv` names which MASTER_KEYS version sealed it, so a rotated key does
-- not strand older rows. `text_iv` is the per-message nonce.
--
-- `text_kv` stays NULL for a row with nothing worth encrypting — an empty
-- string, or a locked room's message, where the real content already lives in
-- `enc_ct` under the room's own passphrase-derived key. Those rows are read
-- back exactly as stored, not run through the at-rest cipher at all.
alter table messages
  add column if not exists text_iv text,
  add column if not exists text_kv integer;
