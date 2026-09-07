-- THE REPLAY CACHE MOVES FROM KV TO D1, audit 2026-09-07 (Grok MAJOR 3).
--
-- claimJti was a KV get-then-put: read the key, and if it was absent, write it.
-- Those are two round trips with no atomicity between them, so two requests
-- carrying the same captured signature both read absent and both proceed. The
-- signature window is 30 minutes either side, so a captured POST to
-- /improve/score, /improve/holdout-credential or /backup/credential could be
-- replayed for an hour by racing it against itself.
--
-- A PRIMARY KEY is the fix, because the database decides rather than the code:
-- INSERT ... ON CONFLICT DO NOTHING RETURNING either returns the row (this call
-- claimed it) or returns nothing (someone else did). There is no window.
--
-- `scope` is the namespace for the two improve endpoints and the literal
-- "backup" for the mirror's credential mint, which the roster can never hold.
CREATE TABLE IF NOT EXISTS improve_jti (
  scope TEXT NOT NULL,
  jti TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, jti)
);

-- Pruned by the nightly backup cron. Entries are only meaningful inside the
-- signature window (30 minutes either side), so a day is generous; the index is
-- what makes the prune cheap.
CREATE INDEX IF NOT EXISTS improve_jti_seen ON improve_jti (seen_at);
