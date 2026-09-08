import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { integrityOf } from "../src/truth-report";
import { improveStatus } from "../src/improve-run";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// THE OTHER HALF OF THE TRUTH REPORT. test/truth-report.test.ts proves which
// statements the handler issues; this proves the document LANDS in a real D1 and
// that improve_status reads its number back out.
//
// The split matters because the two fail differently. A fake that records SQL
// cannot tell whether SQLite accepts the upsert, whether the FTS triggers fire on
// it, or whether ORDER BY path DESC really returns the newest date. This can.

async function connect() {
  const server = buildServer(env as never, "write", "test:integration");
  const client = new Client({ name: "truth-report", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

async function callLint(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: "lint", arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return { isError: result.isError, text: result.content.map((c) => c.text).join("") };
}

describe("lint mode report", () => {
  it("stores a real document, and the FTS index picks it up", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES ('capsid', '[]')").run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'a-spec.md', 'A spec', 'nothing points at this', 'spec', 'published')`
    ).run();

    const client = await connect();
    try {
      const result = await callLint(client, { namespace: "capsid", mode: "report" });
      expect(result.isError, result.text).toBeFalsy();
      const payload = JSON.parse(result.text) as { stored: string; integrity: number | null };
      expect(payload.stored).toMatch(/^capsid\/reports\/lint-\d{4}-\d{2}-\d{2}\.md$/);

      const path = payload.stored.slice("capsid/".length);
      const stored = await env.DB.prepare("SELECT body, type, status FROM documents WHERE namespace = 'capsid' AND path = ?1")
        .bind(path)
        .first<{ body: string; type: string; status: string }>();
      expect(stored, "report mode returned a path and stored nothing there").toBeTruthy();
      expect(stored!.type).toBe("reference");
      expect(integrityOf(stored!.body)).toBe(payload.integrity);

      // The FTS triggers fired on the insert, which is a property only a real
      // schema has: documents_fts is external-content and the trigger is what
      // keeps it in step.
      const indexed = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH 'integrity'"
      ).first<{ n: number }>();
      expect(indexed?.n).toBeGreaterThan(0);

      // And the audit row landed in the same batch. Hard rule 5.
      const audit = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'lint_report' AND namespace = 'capsid'"
      ).first<{ n: number }>();
      expect(audit?.n).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("PLANT: a second run the same day snapshots the first rather than accumulating", async () => {
    const client = await connect();
    try {
      const first = await callLint(client, { namespace: "capsid", mode: "report" });
      expect(first.isError).toBeFalsy();

      const reports = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM documents WHERE namespace = 'capsid' AND path LIKE 'reports/lint-%'"
      ).first<{ n: number }>();
      expect(reports?.n, "one document per namespace per day, not one per invocation").toBe(1);

      // The overwrite went through document_versions, like every other overwrite
      // in this store. A write path that skips the snapshot is hard rule 5.
      const versions = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM document_versions WHERE namespace = 'capsid' AND path LIKE 'reports/lint-%'"
      ).first<{ n: number }>();
      expect(versions?.n, "the prior report must be snapshotted before it is replaced").toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("improve_status surfaces the latest integrity number for the namespace", async () => {
    const status = await improveStatus(env as never, "capsid");
    const capsid = status.namespaces.find((n) => n.namespace === "capsid");
    expect(capsid, "capsid is on the improve roster and must be in the status report").toBeTruthy();
    expect(capsid!.latest_report, "no report was surfaced, though one was just written").toBeTruthy();
    expect(capsid!.latest_report!.path).toMatch(/^capsid\/reports\/lint-\d{4}-\d{2}-\d{2}\.md$/);
    expect(typeof capsid!.latest_report!.integrity).toBe("number");
  });

  it("PLANT: a namespace with no report reports null, which is not an integrity of zero", async () => {
    const status = await improveStatus(env as never, "germomics");
    const germomics = status.namespaces.find((n) => n.namespace === "germomics");
    expect(germomics!.latest_report).toBeNull();
  });

  it("the newest DATE wins, not the most recently rewritten document", async () => {
    // improve_status takes ORDER BY path DESC LIMIT 1 because the filename is
    // ISO-dated and sorts lexically. updated_at would give the most recently
    // REWRITTEN report, and re-running an old date is not a newer measurement.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO documents (namespace, path, title, body, type, status, updated_at)
       VALUES ('capsid', 'reports/lint-2020-01-01.md', 'Old', 'integrity: 1%', 'reference', 'published', datetime('now'))`
    ).run();
    const status = await improveStatus(env as never, "capsid");
    const capsid = status.namespaces.find((n) => n.namespace === "capsid")!;
    expect(capsid.latest_report!.path).not.toContain("2020-01-01");
    expect(capsid.latest_report!.integrity).not.toBe(1);
  });
});
