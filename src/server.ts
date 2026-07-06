import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  APP_KV: KVNamespace;
  MEDIA: R2Bucket;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  OPERATOR_KEY_HASH: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  ADMIN_GITHUB_LOGIN: string;
}

export interface Props extends Record<string, unknown> {
  id: number;
  login: string;
  name: string | null;
}

const SERVER_INFO = { name: "capsid", version: "1.0.0" };

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isOperator(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ") || !env.OPERATOR_KEY_HASH) return false;
  const hash = await sha256Hex(auth.slice("Bearer ".length).trim());
  return hash === env.OPERATOR_KEY_HASH.toLowerCase();
}

export function isAdminUser(env: Env, user: { id: number | string; login: string }): boolean {
  const admin = (env.ADMIN_GITHUB_LOGIN ?? "").trim();
  if (!admin) return false;
  if (/^\d+$/.test(admin)) return String(user.id) === admin;
  return user.login.toLowerCase() === admin.toLowerCase();
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const DENIED = "unauthorized: this tool requires a valid operator key (Authorization: Bearer <key>)";

export function buildServer(env: Env, operator: boolean): McpServer {
  const server = new McpServer(SERVER_INFO);
  const db = env.DB;

  server.registerTool(
    "list",
    {
      description: "List documents with optional namespace, type, and status filters. Returns metadata rows without bodies.",
      inputSchema: {
        namespace: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
      },
    },
    async ({ namespace, type, status }) => {
      const { results } = await db
        .prepare(
          `SELECT id, namespace, path, title, type, status, tags, publish_at, created_at, updated_at
           FROM documents
           WHERE (?1 IS NULL OR namespace = ?1) AND (?2 IS NULL OR type = ?2) AND (?3 IS NULL OR status = ?3)
           ORDER BY namespace, path`
        )
        .bind(namespace ?? null, type ?? null, status ?? null)
        .all();
      return ok(results);
    }
  );

  server.registerTool(
    "read",
    {
      description: "Read a full document by namespace and path.",
      inputSchema: { namespace: z.string(), path: z.string() },
    },
    async ({ namespace, path }) => {
      const row = await db
        .prepare("SELECT * FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first();
      return row ? ok(row) : fail(`not found: ${namespace}/${path}`);
    }
  );

  server.registerTool(
    "write",
    {
      description: "Create or update a document. Snapshots the prior version and writes an audit log entry. Requires operator key.",
      inputSchema: {
        namespace: z.string(),
        path: z.string(),
        title: z.string(),
        body: z.string(),
        type: z.string().optional(),
        tags: z.string().optional(),
        status: z.string().optional(),
      },
    },
    async ({ namespace, path, title, body, type, tags, status }) => {
      if (!operator) return fail(DENIED);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      const statements: D1PreparedStatement[] = [];
      if (prior) {
        statements.push(
          db
            .prepare(
              "INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (?1, ?2, ?3, ?4, ?5)"
            )
            .bind(prior.id, namespace, path, prior.title, prior.body)
        );
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO documents (namespace, path, title, body, type, tags, status)
             VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'note'), ?6, COALESCE(?7, 'published'))
             ON CONFLICT(namespace, path) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               type = COALESCE(?5, documents.type),
               tags = COALESCE(?6, documents.tags),
               status = COALESCE(?7, documents.status),
               updated_at = datetime('now')`
          )
          .bind(namespace, path, title, body, type ?? null, tags ?? null, status ?? null)
      );
      statements.push(
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('operator', 'write', ?1, ?2, ?3)")
          .bind(namespace, path, JSON.stringify({ title, type, tags, status, updated: Boolean(prior) }))
      );
      await db.batch(statements);
      return ok({ namespace, path, action: prior ? "updated" : "created", snapshotted: Boolean(prior) });
    }
  );

  server.registerTool(
    "delete",
    {
      description: "Delete a document. Snapshots it first and writes an audit log entry. Requires operator key.",
      inputSchema: { namespace: z.string(), path: z.string() },
    },
    async ({ namespace, path }) => {
      if (!operator) return fail(DENIED);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      if (!prior) return fail(`not found: ${namespace}/${path}`);
      await db.batch([
        db
          .prepare(
            "INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (?1, ?2, ?3, ?4, ?5)"
          )
          .bind(prior.id, namespace, path, prior.title, prior.body),
        db.prepare("DELETE FROM documents WHERE id = ?1").bind(prior.id),
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('operator', 'delete', ?1, ?2, NULL)")
          .bind(namespace, path),
      ]);
      return ok({ namespace, path, action: "deleted", snapshotted: true });
    }
  );

  server.registerTool(
    "move",
    {
      description: "Rename a document path within its namespace. Audit logged. Requires operator key.",
      inputSchema: { namespace: z.string(), path: z.string(), new_path: z.string() },
    },
    async ({ namespace, path, new_path }) => {
      if (!operator) return fail(DENIED);
      try {
        const result = await db
          .prepare("UPDATE documents SET path = ?3, updated_at = datetime('now') WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path, new_path)
          .run();
        if (result.meta.changes === 0) return fail(`not found: ${namespace}/${path}`);
      } catch (err) {
        return fail(`move failed (target may already exist): ${err instanceof Error ? err.message : String(err)}`);
      }
      await db
        .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('operator', 'move', ?1, ?2, ?3)")
        .bind(namespace, path, JSON.stringify({ new_path }))
        .run();
      return ok({ namespace, path, new_path, action: "moved" });
    }
  );

  server.registerTool(
    "find",
    {
      description: "Find documents whose path matches a glob pattern (SQLite GLOB, e.g. 'notes/*.md'). Optional namespace filter.",
      inputSchema: { namespace: z.string().optional(), glob: z.string() },
    },
    async ({ namespace, glob }) => {
      const { results } = await db
        .prepare(
          `SELECT namespace, path, title, type, status, updated_at
           FROM documents
           WHERE path GLOB ?1 AND (?2 IS NULL OR namespace = ?2)
           ORDER BY namespace, path`
        )
        .bind(glob, namespace ?? null)
        .all();
      return ok(results);
    }
  );

  server.registerTool(
    "search",
    {
      description: "Full text search across all documents (FTS5, ranked by bm25). Optional namespace and type filters. This is the cross-project search.",
      inputSchema: {
        query: z.string(),
        namespace: z.string().optional(),
        type: z.string().optional(),
      },
    },
    async ({ query, namespace, type }) => {
      try {
        const { results } = await db
          .prepare(
            `SELECT d.id, d.namespace, d.path, d.title, d.type, d.status, d.updated_at,
                    snippet(documents_fts, 1, '[', ']', ' ... ', 16) AS snippet
             FROM documents_fts
             JOIN documents d ON d.id = documents_fts.rowid
             WHERE documents_fts MATCH ?1
               AND (?2 IS NULL OR d.namespace = ?2)
               AND (?3 IS NULL OR d.type = ?3)
             ORDER BY bm25(documents_fts)
             LIMIT 25`
          )
          .bind(query, namespace ?? null, type ?? null)
          .all();
        return ok(results);
      } catch (err) {
        return fail(`search failed (check FTS5 query syntax): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  server.registerTool(
    "namespaces",
    {
      description: "List all namespaces and the repos each maps to.",
      inputSchema: {},
    },
    async () => {
      const { results } = await db
        .prepare("SELECT namespace, repos, created_at FROM namespaces ORDER BY namespace")
        .all();
      return ok(results);
    }
  );

  return server;
}
