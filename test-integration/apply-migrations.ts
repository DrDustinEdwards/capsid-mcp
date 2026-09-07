import { applyD1Migrations, env } from "cloudflare:test";

// Real migrations, applied to the real (in-memory) D1 before any integration test
// runs. This is the whole point of the layer: migrations/0001_init.sql creates the
// FTS5 virtual table and its triggers, and nothing in test/ has ever executed
// them. A migration that SQLite rejects, or a trigger that fires on the wrong
// column, was invisible until this file existed.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
