import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import {
  createBranch,
  listRepoTree,
  openPr,
  readRepoFile,
  searchCode,
  writeRepoFile,
} from "./github";

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
  // GitHub App for repo fallthrough (read and write). The private key and
  // installation id are Worker secrets; the client id is a plain var.
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID?: string;
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

type ConfirmVerdict = "accepted" | "declined" | "unsupported";

// Asks the connected client to confirm a destructive action via MCP elicitation.
// Stateless Streamable HTTP clients usually cannot answer server-initiated
// requests, so "unsupported" is the common case and callers must fall back to
// requiring an explicit confirm:true argument.
async function confirmDestructive(server: McpServer, message: string): Promise<ConfirmVerdict> {
  if (!server.server.getClientCapabilities()?.elicitation) return "unsupported";
  try {
    const result = await server.server.elicitInput(
      {
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: "Confirm", description: "Set to true to proceed" },
          },
          required: ["confirm"],
        },
      },
      { timeout: 90_000 }
    );
    return result.action === "accept" && result.content?.confirm === true ? "accepted" : "declined";
  } catch {
    return "unsupported";
  }
}

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
      description: "Create or update a document. Snapshots the prior version and writes an audit log entry. Overwriting an existing document needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true.",
      inputSchema: {
        namespace: z.string(),
        path: z.string(),
        title: z.string(),
        body: z.string(),
        type: z.string().optional(),
        tags: z.string().optional(),
        status: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ namespace, path, title, body, type, tags, status, confirm }) => {
      if (!operator) return fail(DENIED);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      if (prior && confirm !== true) {
        const verdict = await confirmDestructive(
          server,
          `Overwrite ${namespace}/${path}? The current version will be snapshotted to document_versions first.`
        );
        if (verdict === "declined") return fail(`overwrite of ${namespace}/${path} declined`);
        if (verdict === "unsupported") {
          return fail(
            `confirmation required: ${namespace}/${path} already exists. Re-run write with confirm: true to overwrite it. The current version will be snapshotted to document_versions first.`
          );
        }
      }
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
      description: "Delete a document. Snapshots it first and writes an audit log entry. Needs confirmation: the server elicits it when the client supports elicitation, otherwise pass confirm: true.",
      inputSchema: { namespace: z.string(), path: z.string(), confirm: z.boolean().optional() },
    },
    async ({ namespace, path, confirm }) => {
      if (!operator) return fail(DENIED);
      const prior = await db
        .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ id: number; title: string | null; body: string | null }>();
      if (!prior) return fail(`not found: ${namespace}/${path}`);
      if (confirm !== true) {
        const verdict = await confirmDestructive(
          server,
          `Delete ${namespace}/${path}? It will be snapshotted to document_versions first, so it can be recovered.`
        );
        if (verdict === "declined") return fail(`delete of ${namespace}/${path} declined`);
        if (verdict === "unsupported") {
          return fail(
            `confirmation required: re-run delete with confirm: true to remove ${namespace}/${path}. It will be snapshotted to document_versions first.`
          );
        }
      }
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

  // Repo fallthrough: live GitHub access via the Capsid GitHub App. Reads are
  // open to any admitted client; writes require the operator key. The target
  // repo is resolved per namespace from the namespaces table.
  const guarded = async (fn: () => Promise<unknown>) => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  server.registerTool(
    "list_repo_tree",
    {
      description: "List a directory in a namespace's GitHub repo. Omit path for the repo root. Live GitHub, briefly cached.",
      inputSchema: { namespace: z.string(), path: z.string().optional(), ref: z.string().optional() },
    },
    ({ namespace, path, ref }) => guarded(() => listRepoTree(env, namespace, path ?? "", ref))
  );

  server.registerTool(
    "read_repo_file",
    {
      description: "Read a file from a namespace's GitHub repo, decoded to text. Optional ref (branch, tag, or sha). Live GitHub, briefly cached.",
      inputSchema: { namespace: z.string(), path: z.string(), ref: z.string().optional() },
    },
    ({ namespace, path, ref }) => guarded(() => readRepoFile(env, namespace, path, ref))
  );

  server.registerTool(
    "search_code",
    {
      description: "Search code with the GitHub code search API. Pass a namespace to scope to its repo, otherwise searches all of the owner's repos the App can see.",
      inputSchema: { query: z.string(), namespace: z.string().optional() },
    },
    ({ query, namespace }) => guarded(() => searchCode(env, namespace, query))
  );

  server.registerTool(
    "write_repo_file",
    {
      description:
        "Write a file to a namespace's GitHub repo. mode 'pr' (default) commits to a new branch and opens a PR; mode 'direct' commits straight to the default branch. Requires operator key.",
      inputSchema: {
        namespace: z.string(),
        path: z.string(),
        content: z.string(),
        message: z.string(),
        mode: z.enum(["pr", "direct"]).optional(),
        branch: z.string().optional(),
      },
    },
    ({ namespace, path, content, message, mode, branch }) => {
      if (!operator) return Promise.resolve(fail(DENIED));
      return guarded(() => writeRepoFile(env, namespace, path, content, message, mode ?? "pr", branch));
    }
  );

  server.registerTool(
    "create_branch",
    {
      description: "Create a branch in a namespace's GitHub repo. Branches off the default branch unless 'from' is given. Requires operator key.",
      inputSchema: { namespace: z.string(), branch: z.string(), from: z.string().optional() },
    },
    ({ namespace, branch, from }) => {
      if (!operator) return Promise.resolve(fail(DENIED));
      return guarded(() => createBranch(env, namespace, branch, from));
    }
  );

  server.registerTool(
    "open_pr",
    {
      description: "Open a pull request in a namespace's GitHub repo. Base defaults to the repo's default branch. Requires operator key.",
      inputSchema: {
        namespace: z.string(),
        title: z.string(),
        head: z.string(),
        base: z.string().optional(),
        body: z.string().optional(),
      },
    },
    ({ namespace, title, head, base, body }) => {
      if (!operator) return Promise.resolve(fail(DENIED));
      return guarded(() => openPr(env, namespace, title, head, base, body));
    }
  );

  return server;
}
