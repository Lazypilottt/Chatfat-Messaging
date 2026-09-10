-- 004_signing — requirements 5 + 6: every sender signs what they send, and
-- the signature travels with the stored row so it can be re-verified on every
-- future read, not just at the moment it was accepted.
--
-- `sig_pub` is stored per-message rather than looked up from a live session,
-- deliberately: the signer may be long disconnected by the time this row is
-- read back, and verification must not depend on anyone still being online.
alter table messages
  add column if not exists sig text,
  add column if not exists sig_pub text;
