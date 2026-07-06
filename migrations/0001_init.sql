-- Capsid initial schema. Idempotent: applying this on an already-migrated
-- database is a no-op.

CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, path TEXT NOT NULL, title TEXT, body TEXT, type TEXT DEFAULT 'note', status TEXT NOT NULL DEFAULT 'published', tags TEXT, frontmatter TEXT, publish_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(namespace, path));

CREATE TABLE IF NOT EXISTS namespaces (namespace TEXT PRIMARY KEY, repos TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS document_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, namespace TEXT NOT NULL, path TEXT NOT NULL, title TEXT, body TEXT, snapshot_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, namespace TEXT, path TEXT, params TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(title, body, content='documents', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN INSERT INTO documents_fts(documents_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body); END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN INSERT INTO documents_fts(documents_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body); INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
