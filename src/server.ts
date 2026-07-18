import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
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
import { normalizeDashes } from "./normalize";

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

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const DENIED = "unauthorized: this tool requires a write-grant operator key; read-only (ro:) keys can only use the read tools";

// The memory model's document types (capsid/schema.md). Validated on write so
// off-schema types cannot silently escape the lint loop again (docs stored as
// type "session" or "handoff" were invisible to gather and the counts).
const DOC_TYPES = new Set([
  "core", "concept", "semantic", "note", "decision", "spec", "task", "protocol",
  "post", "episodic", "procedural", "source", "prompt", "reference",
]);

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
      if (type && !DOC_TYPES.has(type)) {
        return fail(
          `unknown type '${type}'; valid types: ${[...DOC_TYPES].join(", ")}. Session logs and handoffs are 'episodic'.`
        );
      }
      // Normalize wide dashes server-side so no client can store an em dash,
      // regardless of whether the Claude Code hook ran. See ./normalize.
      title = normalizeDashes(title, "title");
      body = normalizeDashes(body, "prose");
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
      const run = (match: string) =>
        db
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
          .bind(match, namespace ?? null, type ?? null)
          .all();
      try {
        return ok((await run(query)).results);
      } catch {
        // Hyphens, quotes, and bare AND/OR/NOT are FTS5 syntax. Retry the whole
        // query as a quoted phrase so plain text is always a safe input.
        try {
          return ok((await run(`"${query.replace(/"/g, '""')}"`)).results);
        } catch (err) {
          return fail(`search failed (check FTS5 query syntax): ${err instanceof Error ? err.message : String(err)}`);
        }
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
      // unconsolidated = published episodic/source docs not yet archived by the
      // lint loop; surfaced here so every session sees which namespaces need a run.
      const { results } = await db
        .prepare(
          `SELECT n.namespace, n.repos, n.created_at,
                  (SELECT COUNT(*) FROM documents d
                   WHERE d.namespace = n.namespace AND d.type IN ('episodic', 'source')
                     AND d.status = 'published' AND d.path NOT LIKE 'archive/%') AS unconsolidated
           FROM namespaces n ORDER BY n.namespace`
        )
        .all();
      return ok(results);
    }
  );

  // Register a namespace: the one row in the namespaces table that repo tools and
  // the namespaces list read. Writing documents to a new namespace label does not
  // create it, so without this a namespace was a raw D1 insert (how bsw shipped).
  // Create-only: it will not overwrite an existing mapping. Requires operator key.
  const REPO_SHAPE = /^[^/\s]+\/[^/\s]+$/;
  server.registerTool(
    "register_namespace",
    {
      description:
        "Register a namespace by inserting its row in the namespaces table, so repo tools and the namespaces list can see it. Give repo as 'owner/name' (label defaults to 'primary'), or pass a repos JSON array like [{\"repo\":\"owner/name\",\"label\":\"primary\"}] for a multi-repo namespace. Create-only: it will not overwrite an existing namespace. Requires operator key.",
      inputSchema: {
        namespace: z.string(),
        repo: z.string().optional(),
        label: z.string().optional(),
        repos: z.string().optional(),
      },
    },
    async ({ namespace, repo, label, repos }) => {
      if (!operator) return fail(DENIED);
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      let list: Array<{ repo: string; label: string }>;
      if (repos) {
        try {
          const parsed = JSON.parse(repos);
          if (!Array.isArray(parsed) || parsed.length === 0) {
            return fail("repos must be a non-empty JSON array of { repo, label } entries");
          }
          for (const r of parsed) {
            if (!r || typeof r.repo !== "string" || !REPO_SHAPE.test(r.repo)) {
              return fail(`each repos entry needs a "repo" of the form owner/name (got ${JSON.stringify(r)})`);
            }
          }
          list = parsed.map((r) => ({ repo: r.repo, label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : "primary" }));
        } catch (err) {
          return fail(`invalid repos JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        if (!repo || !REPO_SHAPE.test(repo)) {
          return fail('provide repo as "owner/name", or pass a repos JSON array');
        }
        list = [{ repo, label: (label ?? "primary").trim() || "primary" }];
      }
      const existing = await db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(ns).first();
      if (existing) {
        return fail(`namespace already registered: ${ns}. Edit its namespaces row directly to change the repo mapping.`);
      }
      const reposJson = JSON.stringify(list);
      await db.batch([
        db.prepare("INSERT INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind(ns, reposJson),
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('operator', 'register_namespace', ?1, NULL, ?2)")
          .bind(ns, reposJson),
      ]);
      return ok({ namespace: ns, repos: list, action: "registered" });
    }
  );

  // Remap an existing namespace's repos. register_namespace stays the create
  // path; this is the update path that the recova remap needed (previously a raw
  // D1 UPDATE that bypassed the audit log). Snapshots the prior mapping. It does
  // NOT rename the namespace: a rename touches document keys, versions, and audit
  // history and is a separate task.
  server.registerTool(
    "update_namespace",
    {
      description:
        "Remap an existing namespace's repos. Pass repos as a JSON array like [{\"repo\":\"owner/name\",\"label\":\"primary\"},{\"repo\":\"owner/legacy\",\"label\":\"legacy\"}], with exactly one entry labeled \"primary\". The namespace must already exist (use register_namespace to create). Snapshots the prior mapping to the audit log. Does NOT rename the namespace or move its documents. Requires operator key.",
      inputSchema: { namespace: z.string(), repos: z.string() },
    },
    async ({ namespace, repos }) => {
      if (!operator) return fail(DENIED);
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      let list: Array<{ repo: string; label: string }>;
      try {
        const parsed = JSON.parse(repos);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return fail("repos must be a non-empty JSON array of { repo, label } entries");
        }
        for (const r of parsed) {
          if (!r || typeof r.repo !== "string" || !REPO_SHAPE.test(r.repo)) {
            return fail(`each repos entry needs a "repo" of the form owner/name (got ${JSON.stringify(r)})`);
          }
        }
        list = parsed.map((r) => ({ repo: r.repo, label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : "primary" }));
      } catch (err) {
        return fail(`invalid repos JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const primaries = list.filter((r) => r.label === "primary").length;
      if (primaries !== 1) {
        return fail(`repos must have exactly one entry labeled "primary" (found ${primaries})`);
      }
      const existing = await db
        .prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
        .bind(ns)
        .first<{ repos: string }>();
      if (!existing) return fail(`namespace not found: ${ns}. Use register_namespace to create it.`);
      const reposJson = JSON.stringify(list);
      await db.batch([
        db.prepare("UPDATE namespaces SET repos = ?2 WHERE namespace = ?1").bind(ns, reposJson),
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('operator', 'update_namespace', ?1, NULL, ?2)")
          .bind(ns, JSON.stringify({ old: existing.repos, new: reposJson })),
      ]);
      return ok({ namespace: ns, repos: list, action: "updated", previous: existing.repos });
    }
  );

  // Consolidation loop (the LLM Wiki maintenance step). The Worker does no
  // reasoning: a capable client calls gather, synthesizes the update with the
  // existing read/write tools, then calls finalize to archive what it consumed.
  server.registerTool(
    "lint",
    {
      description:
        "Consolidation loop for a namespace. mode 'gather' (default, read-only) returns the packet a driving LLM needs to compile the wiki: current core.md, the concept and decision docs, every unconsolidated episodic and source doc, and the capsid schema and conventions rules. After writing the updated core.md and concept docs via write, call mode 'finalize' with consumed: the episodic/source paths that were compiled. Finalize moves them under archive/ (never deletes, never touches core or concept docs) and writes one audit row. Finalize requires operator key.",
      inputSchema: {
        namespace: z.string(),
        mode: z.enum(["gather", "finalize"]).optional(),
        consumed: z.array(z.string()).optional(),
      },
    },
    async ({ namespace, mode, consumed }) => {
      if ((mode ?? "gather") === "gather") {
        const core = await db
          .prepare("SELECT namespace, path, title, type, status, body, updated_at FROM documents WHERE namespace = ?1 AND path = 'core.md'")
          .bind(namespace)
          .first();
        const wiki = await db
          .prepare(
            `SELECT namespace, path, title, type, status, tags, body, updated_at
             FROM documents
             WHERE namespace = ?1 AND type IN ('concept', 'decision')
             ORDER BY path`
          )
          .bind(namespace)
          .all();
        const raw = await db
          .prepare(
            `SELECT namespace, path, title, type, status, tags, body, created_at, updated_at
             FROM documents
             WHERE namespace = ?1 AND type IN ('episodic', 'source')
               AND status = 'published' AND path NOT LIKE 'archive/%'
             ORDER BY created_at`
          )
          .bind(namespace)
          .all();
        const rules = await db
          .prepare("SELECT namespace, path, title, body FROM documents WHERE namespace = 'capsid' AND path IN ('schema.md', 'conventions.md') ORDER BY path")
          .all();
        // Rough packet size so a driving LLM knows when a gather will not fit
        // its context and it should consolidate in batches instead.
        const packetChars = [core, ...wiki.results, ...raw.results, ...rules.results].reduce(
          (sum, row) => sum + String((row as { body?: unknown } | null)?.body ?? "").length,
          0
        );
        return ok({
          mode: "gather",
          namespace,
          core: core ?? null,
          wiki: wiki.results,
          unconsolidated: raw.results,
          rules: rules.results,
          packet_chars: packetChars,
          ...(packetChars > 150_000
            ? { warning: "large packet: consider consolidating the oldest unconsolidated docs first, in batches, using read on individual paths" }
            : {}),
        });
      }

      if (!operator) return fail(DENIED);
      const paths = [...new Set(consumed ?? [])];
      if (paths.length === 0) {
        return fail("finalize requires consumed: the episodic/source paths that were compiled into the wiki");
      }
      const problems: string[] = [];
      for (const path of paths) {
        const row = await db
          .prepare("SELECT type FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
          .first<{ type: string | null }>();
        if (!row) problems.push(`not found: ${namespace}/${path}`);
        else if (path.startsWith("archive/")) problems.push(`already archived: ${namespace}/${path}`);
        else if (row.type !== "episodic" && row.type !== "source") {
          problems.push(`not consumable: ${namespace}/${path} has type '${row.type}' (only episodic and source docs are archived)`);
        }
      }
      if (problems.length > 0) return fail(`finalize aborted, nothing archived:\n${problems.join("\n")}`);
      const statements = paths.map((path) =>
        db
          .prepare("UPDATE documents SET path = 'archive/' || path, updated_at = datetime('now') WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
      );
      statements.push(
        db
          .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('operator', 'lint', ?1, NULL, ?2)")
          .bind(namespace, JSON.stringify({ consolidated: paths.length, consumed: paths }))
      );
      try {
        await db.batch(statements);
      } catch (err) {
        return fail(`finalize failed, nothing archived (an archive/ target may already exist): ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok({
        mode: "finalize",
        namespace,
        consolidated: paths.length,
        archived: paths.map((path) => ({ from: path, to: `archive/${path}` })),
      });
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

  // Repo writes are operator-gated and audit-logged. The whole result (which
  // includes the resolved repo) goes into params so a misdirected write is
  // diagnosable from the log; path is the file path where one applies.
  const guardedWrite = async (
    action: string,
    namespace: string,
    path: string | null,
    fn: () => Promise<Record<string, unknown>>
  ) => {
    if (!operator) return fail(DENIED);
    let result: Record<string, unknown>;
    try {
      result = await fn();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    await db
      .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('operator', ?1, ?2, ?3, ?4)")
      .bind(action, namespace, path, JSON.stringify(result))
      .run();
    return ok(result);
  };

  // A namespace can map to more than one repo (e.g. recova -> foxhound primary +
  // recova legacy). The optional `repo` argument on every repo tool selects one:
  // pass a label ("primary", "legacy") or a full "owner/name" that is mapped to
  // the namespace. Omit it to target the primary repo. Use `namespaces` to see
  // the mapping.
  const REPO_ARG = "Optional repo selector for a multi-repo namespace: a label (\"primary\", \"legacy\") or a mapped \"owner/name\". Defaults to the primary repo.";

  server.registerTool(
    "list_repo_tree",
    {
      description: "List a directory in a namespace's GitHub repo. Omit path for the repo root. Live GitHub, briefly cached.",
      inputSchema: { namespace: z.string(), path: z.string().optional(), ref: z.string().optional(), repo: z.string().optional().describe(REPO_ARG) },
    },
    ({ namespace, path, ref, repo }) => guarded(() => listRepoTree(env, namespace, path ?? "", ref, repo))
  );

  server.registerTool(
    "read_repo_file",
    {
      description: "Read a file from a namespace's GitHub repo, decoded to text. Optional ref (branch, tag, or sha). Live GitHub, briefly cached.",
      inputSchema: { namespace: z.string(), path: z.string(), ref: z.string().optional(), repo: z.string().optional().describe(REPO_ARG) },
    },
    ({ namespace, path, ref, repo }) => guarded(() => readRepoFile(env, namespace, path, ref, repo))
  );

  server.registerTool(
    "search_code",
    {
      description:
        "Case-insensitive substring search across a namespace repo's files. Walks the repo tree and greps blobs server-side (GitHub's code-search index does not serve these private repos over an App token), so scope with path_prefix on large repos. Returns path, line number, and the matching line. namespace is required.",
      inputSchema: {
        query: z.string(),
        namespace: z.string(),
        path_prefix: z.string().optional().describe("Only scan files whose path starts with this prefix, e.g. 'src/'."),
        ref: z.string().optional().describe("Branch, tag, or sha to search. Defaults to the default branch."),
        max_results: z.number().int().positive().optional().describe("Cap on returned matches (default 20)."),
        repo: z.string().optional().describe(REPO_ARG),
      },
    },
    ({ query, namespace, path_prefix, ref, max_results, repo }) =>
      guarded(() => searchCode(env, namespace, query, { pathPrefix: path_prefix, ref, maxResults: max_results, repoSelector: repo }))
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
        repo: z.string().optional().describe(REPO_ARG),
      },
    },
    ({ namespace, path, content, message, mode, branch, repo }) =>
      guardedWrite("write_repo_file", namespace, path, () =>
        writeRepoFile(env, namespace, path, content, message, mode ?? "pr", branch, repo)
      )
  );

  server.registerTool(
    "create_branch",
    {
      description: "Create a branch in a namespace's GitHub repo. Branches off the default branch unless 'from' is given. Requires operator key.",
      inputSchema: { namespace: z.string(), branch: z.string(), from: z.string().optional(), repo: z.string().optional().describe(REPO_ARG) },
    },
    ({ namespace, branch, from, repo }) =>
      guardedWrite("create_branch", namespace, null, () => createBranch(env, namespace, branch, from, repo))
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
        repo: z.string().optional().describe(REPO_ARG),
      },
    },
    ({ namespace, title, head, base, body, repo }) =>
      guardedWrite("open_pr", namespace, null, () => openPr(env, namespace, title, head, base, body, repo))
  );

  // Resources: every document is addressable context at capsid://<namespace>/<path>.
  // Read-only, same visibility as the read tool. The D1 queries run lazily, only
  // when a client actually calls resources/list or resources/read.
  server.registerResource(
    "document",
    new ResourceTemplate("capsid://{namespace}/{+path}", {
      list: async () => {
        const { results } = await db
          .prepare("SELECT namespace, path, title FROM documents ORDER BY namespace, path")
          .all<{ namespace: string; path: string; title: string | null }>();
        return {
          resources: results.map((row) => ({
            uri: `capsid://${row.namespace}/${row.path}`,
            name: `${row.namespace}/${row.path}`,
            title: row.title ?? undefined,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    // Template metadata spreads onto every listed resource, so keep it to
    // fields that are true per document.
    { title: "Capsid documents", mimeType: "text/markdown" },
    async (uri, variables) => {
      const namespace = String(variables.namespace);
      const path = String(variables.path);
      const row = await db
        .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
        .bind(namespace, path)
        .first<{ body: string | null }>();
      if (!row) throw new McpError(ErrorCode.InvalidParams, `not found: ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: row.body ?? "" }] };
    }
  );

  // Prompts: reusable templates stored as type 'prompt' documents whose bodies
  // use {{variable}} placeholders. Handled at the protocol level (McpServer only
  // lists prompts registered at build time) so the D1 query runs lazily, only on
  // prompts/list and prompts/get. Prompt name is the doc path without .md.
  const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  const promptVariables = (body: string) => [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))];
  server.server.registerCapabilities({ prompts: { listChanged: false } });
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const { results } = await db
      .prepare("SELECT path, title, body FROM documents WHERE type = 'prompt' ORDER BY namespace, path")
      .all<{ path: string; title: string | null; body: string | null }>();
    return {
      prompts: results.map((row) => ({
        name: row.path.replace(/\.md$/, ""),
        description: row.title ?? undefined,
        arguments: promptVariables(row.body ?? "").map((name) => ({ name, required: true })),
      })),
    };
  });
  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    const row = await db
      .prepare("SELECT title, body FROM documents WHERE type = 'prompt' AND (path = ?1 OR path = ?1 || '.md') LIMIT 1")
      .bind(name)
      .first<{ title: string | null; body: string | null }>();
    if (!row) throw new McpError(ErrorCode.InvalidParams, `prompt not found: ${name}`);
    const missing = new Set<string>();
    const text = (row.body ?? "").replace(PLACEHOLDER, (placeholder, variable: string) => {
      const value = args[variable];
      if (value === undefined) {
        missing.add(variable);
        return placeholder;
      }
      return String(value);
    });
    if (missing.size > 0) {
      throw new McpError(ErrorCode.InvalidParams, `missing arguments for prompt ${name}: ${[...missing].join(", ")}`);
    }
    return {
      description: row.title ?? undefined,
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    };
  });

  return server;
}
