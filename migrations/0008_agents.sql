-- AGENTS AS USERS. One row per caller, with its own key, its own scopes and its own
-- audit identity. Idempotent.
--
-- WHAT WAS WRONG. Authorization was two tiers wide: `OPERATOR_KEY_HASH` held a handful
-- of comma-separated hashes, a plain entry meant WRITE EVERYTHING and an `ro:` entry
-- meant read everything. Every headless caller shared that vocabulary: the improve
-- driver, the queue driver, a laptop session and cron all presented a key that could
-- merge a pull request into a repo that deploys on push, write straight to a default
-- branch, dispatch a workflow, and rewrite any document in any namespace. The audit log
-- recorded twelve hex of the key's digest, so "which caller did this" was answerable
-- only if somebody remembered which machine held which key.
--
-- The queue is what made that untenable rather than merely untidy. A job is executable
-- input posted from a chat and worked by a session holding local shell and repo
-- credentials, and until now every one of those sessions presented the same credential
-- as the seat that posts the work.
--
-- THE SCOPES COLUMN IS JSON, NOT COLUMNS. Five axes (namespaces, repos, tools, grants,
-- flags) with a list or "*" on each; a column per axis would mean a migration every
-- time an axis gains a value, and the enforcement point parses the whole thing in one
-- place anyway (src/agents-schema.ts, parseScopes). The parse FAILS CLOSED: a scopes
-- column that is null, empty, truncated or the wrong shape resolves to no namespaces,
-- no tools, no grants and no flags, because a permissive parse of a corrupt row looks
-- exactly like a working one until the day it matters.
--
-- REVOKED, NOT DELETED. `revoked_at` is a timestamp rather than a DELETE, so the audit
-- rows an agent wrote keep resolving to a row that says what it was allowed to do. The
-- resolver reads only rows where it is NULL.
--
-- NO PLAINTEXT KEY IS EVER STORED. `key_hash` is the sha256 of the minted key, the same
-- verifier shape `OPERATOR_KEY_HASH` uses, compared in constant time. The key itself is
-- returned once by `agents` action "mint" and exists nowhere afterwards.

CREATE TABLE IF NOT EXISTS agents (
  -- agent_<12 hex>, minted by the Worker. Not AUTOINCREMENT, for the reason job ids
  -- are not: an id that is quoted in a command invites addressing the next one by
  -- arithmetic.
  id TEXT PRIMARY KEY,
  -- The audit identity. `agent:<name>` is what lands in audit_log.actor and in
  -- jobs.claimed_by, which is why it is UNIQUE: two agents sharing a name would make
  -- every audit row ambiguous about which of them wrote it.
  name TEXT NOT NULL UNIQUE,
  -- session | driver | seat | cron. Enforced in src/agents-schema.ts and asserted
  -- against this comment by test/agents-schema.test.ts, in both directions. It is
  -- descriptive, not authorizing: what an agent may do is in scopes and nowhere else,
  -- so a kind cannot quietly become a second permission system.
  kind TEXT NOT NULL,
  -- sha256 hex of the minted key. UNIQUE because the resolver walks the live rows and
  -- compares in constant time; two rows with one hash would resolve non-deterministically.
  key_hash TEXT NOT NULL UNIQUE,
  -- The five axes as JSON. See src/agents-schema.ts.
  scopes TEXT NOT NULL,
  -- The actor that minted it, in audit_log.actor vocabulary.
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set rather than deleted. A revoked agent stops resolving and stays readable.
  revoked_at TEXT,
  -- Last successful resolution, written best-effort outside the request path. It is
  -- the answer to "is this credential still in use", which is what makes revoking an
  -- unused one cheap to decide.
  last_seen TEXT
);

-- The resolver's read: every live agent, to compare in constant time. Partial, so a
-- revoked row costs nothing.
CREATE INDEX IF NOT EXISTS agents_live ON agents (revoked_at) WHERE revoked_at IS NULL;
