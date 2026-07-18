-- Typed, directional links between documents (the ontology layer, item 6).
-- Edges are asserted by hand or via the write tool's links param, never bulk
-- extracted. This table is the queryable truth; the backlinks tool reads it.
-- Idempotent: applying on an already-migrated database is a no-op.

CREATE TABLE IF NOT EXISTS document_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_ns TEXT NOT NULL,
  from_path TEXT NOT NULL,
  type TEXT NOT NULL,
  to_ns TEXT NOT NULL,
  to_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_ns, from_path, type, to_ns, to_path)
);

CREATE INDEX IF NOT EXISTS document_links_from ON document_links (from_ns, from_path);
CREATE INDEX IF NOT EXISTS document_links_to ON document_links (to_ns, to_path);
