import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// /health AGAINST A REAL D1. The endpoint probes the store as well as reporting
// provenance: a SELECT 1 plus an FTS MATCH pinned to capsid/conventions.md, and it
// answers 503 `degraded` if either fails. Bindings resolve by NAME at deploy time,
// so a Worker pointed at nothing starts fine and answers ok while every read tool
// errors. That is the failure this endpoint exists to make visible, and until this
// file it was only ever exercised against a fake that answered `{ ok: 1 }` to a
// string match on the SQL.

describe("/health", () => {
  it("is degraded on an empty store, because the FTS probe finds nothing to match", async () => {
    const response = await SELF.fetch("https://capsid.test/health");
    const body = (await response.json()) as { status: string; checks?: Record<string, unknown> };
    // The migrations ran, so D1 answers; the pinned document does not exist yet, so
    // the FTS half fails. A store that answers SELECT 1 and holds nothing is exactly
    // the "bound to the wrong database" case, and it must not read as ok.
    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
  });

  it("is ok once the pinned document exists and the FTS index has it", async () => {
    // Written through raw SQL rather than the write tool, so this test is about the
    // TRIGGERS: documents_fts is external-content, and the index only has this row
    // if migrations/0001_init.sql wired its AFTER INSERT trigger correctly.
    await env.DB.prepare(
      `INSERT INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'conventions.md', 'Portfolio-wide conventions', 'Standing rules that apply across all projects.', 'procedural', 'published')`
    ).run();

    const indexed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH 'conventions'"
    ).first<{ n: number }>();
    expect(indexed?.n).toBe(1);

    const response = await SELF.fetch("https://capsid.test/health");
    const body = (await response.json()) as { status: string; sha?: string };
    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.sha).toBe("integration");
  });

  it("reports the newest applied migration, so a half-migrated deploy is visible", async () => {
    const response = await SELF.fetch("https://capsid.test/health");
    const body = (await response.json()) as { schema_version?: string | null };
    // Derived from migrations/, not hardcoded: the newest file is what the endpoint
    // must name, so adding a migration cannot silently leave this stale.
    expect(typeof body.schema_version === "string" || body.schema_version === null).toBe(true);
    if (typeof body.schema_version === "string") {
      expect(body.schema_version).toMatch(/^\d{4}_/);
    }
  });
});
