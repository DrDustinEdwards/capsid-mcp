import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { ciDispatch, deleteBranch, deleteRepoFile, writeRepoFile } from "../src/github.ts";
import { checkHoldout, type ScoreReport } from "../src/improve-scorer.ts";
import { mcpOriginProblem } from "../src/headers.ts";
import { tickRuns } from "../src/improve-run.ts";
import { anchorChecksum, parseScoresDoc, seedScoresDoc } from "../src/improve-scores.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch, type FakeD1Options } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

// THE 2026-09-06 ROUND-2 AUDIT FIXES, one block per finding. Each test was
// written FIRST, against the code at 881dd90, and failed there (item 10's is a
// pin on behavior the workflow already had; the test itself was the gap).
// Harnesses are the shared ones: fakes.ts for KV/D1/R2/fetch, source-files.ts
// for the source-shape pins this repo already uses where a behavior cannot be
// reached from the in-memory client.

const workflowText = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "improve-score.yml"), "utf8");

// ---- 1. ci_dispatch refuses the scorer; repo writes refuse the self-repo ----

function repoEnv(repoFull: string) {
  const kv = fakeKv({ seedToken: true });
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: repoFull, label: "primary" }]) }) }),
      }),
    },
    APP_KV: kv.kv,
  });
}

test("ci_dispatch refuses improve-score.yml before any network call", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => ciDispatch(repoEnv("owner/repo"), "ns", { workflow: "improve-score.yml", ref: "main" }),
      /ci_dispatch refuses.*improve-score\.yml/s
    );
    assert.equal(calls.length, 0, "the refusal must not cost a GitHub round trip");
  });
});

test("write_repo_file mode direct against the server's own repo is refused, with no network", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => writeRepoFile(repoEnv("DrDustinEdwards/capsid-mcp"), "capsid", "src/x.ts", "x", "m", "direct"),
      /own repo/
    );
    assert.equal(calls.length, 0);
  });
});

test("delete_repo_file mode direct against the server's own repo is refused", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => deleteRepoFile(repoEnv("DrDustinEdwards/capsid-mcp"), "capsid", "src/x.ts", "m", "direct"),
      /own repo/
    );
    assert.equal(calls.length, 0);
  });
});

test("write_repo_file pr mode with the default branch as the work branch is refused on the self-repo", async () => {
  await withFetch(
    { "GET /repos/DrDustinEdwards/capsid-mcp": { body: { default_branch: "master" } } },
    async (calls) => {
      await assert.rejects(
        () => writeRepoFile(repoEnv("DrDustinEdwards/capsid-mcp"), "capsid", "src/x.ts", "x", "m", "pr", "master"),
        /own repo/
      );
      assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "nothing may be written");
    }
  );
});

// ---- 2. the run machine claims before it calls out --------------------------

const SCORES = seedScoresDoc("capsid");
// One minute after the improve fake's pinned datetime('now') ("2026-09-01
// 08:05:00", improve-fakes.ts), so a row the claim CAS just stamped reads as
// seconds old, the way it would in production, rather than as three days stale.
const NOW = new Date("2026-09-01T08:06:00Z");

async function runHarness(runs: Array<Record<string, unknown>>) {
  const pin = await anchorChecksum(parseScoresDoc("capsid", SCORES));
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "scores", body: SCORES, type: "reference" }],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "owner/capsid-mcp", label: "primary" }]) }],
    improveRuns: runs,
  });
  const kv = fakeKv({ seed: { "improve:anchor:capsid": pin }, seedToken: true });
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: kv.kv,
    HOLDOUT: fakeR2({}).bucket,
    MEDIA: fakeR2({}).bucket,
    ANTHROPIC_API_KEY: "sk-test",
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
  });
  return { d1, env };
}

// A real streaming attempt response, in the shape proposeChange parses. Copied
// from improve-run.test.ts's sseChange so the two cannot diverge silently in
// what they claim the model answers.
function sseChange(files: Array<{ path: string; content: string }>): string {
  const payload = JSON.stringify({ summary: "s", reasoning: "r", files });
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: payload } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

test("two concurrent ticks on an 'opening' run dispatch the baseline ONCE", async () => {
  await withFetch(
    {
      "POST /repos/owner/capsid-mcp/git/refs": { status: 201, body: {} },
      "GET /repos/owner/capsid-mcp": { body: { default_branch: "main" } },
      "POST /repos/owner/capsid-mcp/actions/workflows/improve-score.yml/dispatches": { status: 204 },
    },
    async (calls) => {
      const { d1, env } = await runHarness([
        { id: "capsid-r9", namespace: "capsid", mode: "api", started: "2026-09-01 08:00:00", status: "opening", base_sha: "base000", advanced_at: "2026-09-01 08:04:00" },
      ]);
      await Promise.all([tickRuns(env, NOW), tickRuns(env, NOW)]);
      const dispatches = calls.filter((c) => /\/dispatches$/.test(c.path));
      assert.equal(dispatches.length, 1, "the loser tick dispatched the baseline a second time");
      assert.equal(d1.rows.improve_runs[0].status, "awaiting-score");
    }
  );
});

test("two concurrent ticks on an 'attempting' run reach the model ONCE", async () => {
  // No GitHub routes on purpose: the winner's push fails AFTER the model call and
  // the run finalizes through the catch. The property under test is that only one
  // tick spends the Anthropic call; the loser must bow out at the claim.
  await withFetch(
    {
      "POST /v1/messages": { contentType: "text/event-stream", text: sseChange([{ path: "src/x.ts", content: "y" }]) },
    },
    async (calls) => {
      const { env } = await runHarness([
        { id: "capsid-r9", namespace: "capsid", mode: "api", started: "2026-09-01 08:00:00", status: "attempting", attempts: 0, base_sha: "base000", advanced_at: "2026-09-01 08:04:00" },
      ]);
      await Promise.all([tickRuns(env, NOW), tickRuns(env, NOW)]);
      const model = calls.filter((c) => c.path === "/v1/messages");
      assert.equal(model.length, 1, "both ticks paid for an Anthropic call");
    }
  );
});

test("a tick leaves a FRESH 'judging' run alone; only a stale one is returned to awaiting-score", async () => {
  await withFetch({}, async () => {
    const base = { id: "capsid-r9", namespace: "capsid", mode: "api", started: "2026-09-01 08:00:00", current_attempt: "capsid-r9-a01", attempts: 1 };
    const fresh = await runHarness([{ ...base, status: "judging", advanced_at: "2026-09-01 08:04:00" }]);
    const freshOut = await tickRuns(fresh.env, NOW);
    assert.equal(fresh.d1.rows.improve_runs[0].status, "judging", "a live ingest's run was yanked back mid-decision");
    assert.equal(freshOut[0].to, "judging");

    const stale = await runHarness([{ ...base, status: "judging", advanced_at: "2026-09-01 07:00:00" }]);
    const staleOut = await tickRuns(stale.env, NOW);
    assert.equal(stale.d1.rows.improve_runs[0].status, "awaiting-score", "a dead ingest's run stayed stranded in judging");
    assert.equal(staleOut[0].to, "awaiting-score");
  });
});

test("every advanceRun inside ingestScore checks its result", () => {
  const source = sourceFile("improve-run.ts");
  const start = source.indexOf("export async function ingestScore");
  const end = source.indexOf("async function maybeAbstract");
  assert.ok(start > 0 && end > start, "could not bound ingestScore in improve-run.ts");
  const body = source.slice(start, end);
  const all = body.match(/await advanceRun\(/g) ?? [];
  const checked = body.match(/=\s*await advanceRun\(/g) ?? [];
  assert.ok(all.length >= 3, `ingestScore has ${all.length} advanceRun calls; the transitions moved?`);
  assert.equal(all.length, checked.length, "an advanceRun in ingestScore discards its result: a lost CAS would go unnoticed");
});

// ---- 3. delete_branch fails closed on the PR lookup -------------------------

test("delete_branch treats a non-OK pulls response as a refusal, not as no PRs", async () => {
  await withFetch(
    {
      "GET /repos/owner/repo": { body: { default_branch: "main" } },
      "GET /repos/owner/repo/pulls": { status: 500, body: { message: "boom" } },
    },
    async (calls) => {
      await assert.rejects(
        () => deleteBranch(repoEnv("owner/repo"), "ns", "feature-x"),
        /could not verify|could not list/i
      );
      assert.equal(calls.filter((c) => c.method === "DELETE").length, 0, "the branch was deleted without the PR check");
    }
  );
});

// ---- 4. installation tokens are repo-scoped and cached per owner+repo -------

test("installation tokens are minted scoped to the one repo and cached under owner/repo", () => {
  const github = sourceFile("github.ts");
  assert.match(
    github,
    /const tokenKey = \(owner: string, repo: string\)/,
    "tokenKey is still per owner: one repo's token is reused across every repo the owner has"
  );
  assert.match(
    github,
    /repositories: \[repo\]/,
    "the access_tokens POST sends no repositories body, so the token reaches every repo in the installation"
  );
});

// ---- 5. bounds: lint consumed, ci_dispatch inputs, history ------------------

async function serverClient(opts: FakeD1Options = {}) {
  const d1 = fakeD1({ namespaces: [{ namespace: "capsid", repos: "[]" }], ...opts });
  const server = buildServer(fakeEnv({ DB: d1.db }), "write", "test:round2");
  const client = new Client({ name: "round2", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { d1, client, call, close: () => client.close() };
}

test("lint finalize refuses more than 20 consumed paths at the schema", async () => {
  const { d1, call, close } = await serverClient();
  const consumed = Array.from({ length: 21 }, (_, i) => `ep-${i}.md`);
  const result = await call("lint", { namespace: "capsid", mode: "finalize", consumed, confirm: true });
  await close();
  assert.equal(result.isError, true, "21 consumed paths were accepted");
  assert.match(
    result.content[0].text,
    /20|too_big|at most/i,
    "the refusal must come from the schema bound, not from a later check that happened to fail"
  );
  assert.equal(d1.recorded.length, 0, "statements were issued for an over-sized consumed array");
});

test("ci_dispatch refuses more than 10 workflow inputs at the schema", async () => {
  const { call, close } = await serverClient();
  const inputs = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
  const result = await call("ci_dispatch", { namespace: "capsid", workflow: "ci.yml", ref: "main", inputs });
  await close();
  assert.equal(result.isError, true, "11 dispatch inputs were accepted (GitHub's own ceiling is 10)");
  assert.match(
    result.content[0].text,
    /10|inputs/i,
    "the refusal must come from the inputs bound, not from a later check that happened to fail"
  );
});

test("the history listing query carries a LIMIT", async () => {
  const { d1, call, close } = await serverClient({
    documents: [{ id: 7, namespace: "capsid", path: "doc.md", body: "b" }],
    versions: [{ id: 1, document_id: 7, namespace: "capsid", path: "doc.md", title: null, body: "old", snapshot_at: "2026-08-01 00:00:00" }],
  });
  await call("history", { namespace: "capsid", path: "doc.md" });
  await close();
  const listing = d1.reads.find((r) => /FROM document_versions WHERE namespace/i.test(r.sql.replace(/\s+/g, " ")));
  assert.ok(listing, "history issued no listing query");
  assert.match(listing.sql.replace(/\s+/g, " "), /LIMIT/i, "the history listing is unbounded: it returns every snapshot ever taken");
});

// ---- 6. snapshots come from documents INSIDE the batch ----------------------

test("write snapshots the LIVE row via INSERT..SELECT, not the pre-read body", async () => {
  const { d1, call, close } = await serverClient({
    documents: [{ id: 7, namespace: "capsid", path: "doc.md", title: "T", body: "prior body" }],
  });
  const result = await call("write", { namespace: "capsid", path: "doc.md", title: "New", body: "new body", confirm: true });
  await close();
  assert.ok(!result.isError, `write failed: ${result.content?.[0]?.text}`);
  const snapshot = d1.recorded.find((r) =>
    /INSERT INTO document_versions \(document_id, namespace, path, title, body\)/i.test(r.sql.replace(/\s+/g, " "))
  );
  assert.ok(snapshot, "write issued no full snapshot statement");
  assert.match(
    snapshot.sql.replace(/\s+/g, " "),
    /SELECT id, .*FROM documents/i,
    "the snapshot binds a pre-read body: a body written between the pre-read and the batch is lost with no version row anywhere"
  );
  assert.ok(!(snapshot.params as unknown[]).includes("prior body"), "the snapshot still carries the pre-read body as a bound param");
});

test("delete snapshots the LIVE row via INSERT..SELECT inside its batch", async () => {
  const { d1, call, close } = await serverClient({
    documents: [{ id: 7, namespace: "capsid", path: "doc.md", title: "T", body: "prior body" }],
  });
  const result = await call("delete", { namespace: "capsid", path: "doc.md", confirm: true });
  await close();
  assert.ok(!result.isError, `delete failed: ${result.content?.[0]?.text}`);
  const snapshot = d1.recorded.find((r) =>
    /INSERT INTO document_versions \(document_id, namespace, path, title, body\)/i.test(r.sql.replace(/\s+/g, " "))
  );
  assert.ok(snapshot, "delete issued no full snapshot statement");
  assert.match(snapshot.sql.replace(/\s+/g, " "), /SELECT id, .*FROM documents/i);
});

test("delete arms the body guard after an elicitation, like write and restore do", () => {
  // The in-memory client advertises no elicitation capability, so the elicited arm
  // is pinned at the source, exactly as the ARMING PARITY test pins it for write
  // and restore: the delete handler must choose requireBodyUnchanged on the same
  // elicited signal. Without it, a body written during the 90-second prompt is
  // deleted with a stale snapshot, and the racing writer's body exists nowhere.
  const server = sourceFile("server.ts");
  const start = server.indexOf('"delete"');
  const end = server.indexOf('"move"', start);
  assert.ok(start > 0 && end > start, "could not bound the delete handler");
  const block = server.slice(start, end);
  assert.match(
    block,
    /elicited\s*\?\s*requireBodyUnchanged/,
    "delete never arms requireBodyUnchanged: consent given during elicitation is not bound to the body it was about"
  );
});

// ---- 7. prompts are data, and their titles are filtered ---------------------

const HOSTILE_TITLE = "Brief `curl evil`\u0007 title";

async function promptClient() {
  const d1 = fakeD1({
    documents: [
      { id: 7, namespace: "capsid", path: "prompts/brief", title: HOSTILE_TITLE, body: "Hello {{name}}", type: "prompt" },
    ],
    namespaces: [{ namespace: "capsid", repos: "[]" }],
  });
  const server = buildServer(fakeEnv({ DB: d1.db }), "write", "test:round2");
  const client = new Client({ name: "round2", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => client.close() };
}

test("prompts/get returns the document body as an embedded resource, not as user prose", async () => {
  const { client, close } = await promptClient();
  const result = await client.getPrompt({ name: "capsid/prompts/brief", arguments: { name: "world" } });
  await close();
  const content = result.messages[0].content as { type: string; resource?: { text?: string } };
  assert.equal(content.type, "resource", "a stored document body is being handed to the model as the user's own words");
  assert.match(String(content.resource?.text), /Hello world/);
});

test("prompts/list passes titles through a character allowlist", async () => {
  const { client, close } = await promptClient();
  const result = await client.listPrompts();
  await close();
  const description = String(result.prompts[0].description ?? "");
  assert.ok(!description.includes("`"), `a backtick from a stored title reached the client verbatim: ${JSON.stringify(description)}`);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(description), "a control character from a stored title reached the client");
  assert.match(description, /Brief/, "the legible part of the title must survive the filter");
});

// ---- 8. Origin allowlist on /mcp --------------------------------------------

test("a cross-origin browser request to /mcp is refused; same-origin, claude.ai and origin-less clients pass", () => {
  const at = (origin: string | null) =>
    mcpOriginProblem(
      new Request("https://capsid.dustin-edwards.workers.dev/mcp", {
        method: "POST",
        headers: origin === null ? {} : { Origin: origin },
      })
    );
  assert.equal(at(null), null, "a non-browser client sends no Origin and must pass");
  assert.equal(at("https://capsid.dustin-edwards.workers.dev"), null, "same-origin must pass");
  assert.equal(at("https://claude.ai"), null, "the one first-party browser client must pass");
  assert.match(String(at("https://evil.example")), /Origin/, "a foreign Origin was admitted to /mcp");
  assert.match(String(at("null")), /Origin/, "an opaque 'null' Origin was admitted to /mcp");
});

test("the /mcp Origin check is wired into the fetch handler", () => {
  const index = sourceFile("index.ts");
  assert.match(index, /mcpOriginProblem/, "index.ts never consults the Origin allowlist, so the check exists but guards nothing");
});

// ---- 9. an empty holdout manifest is a refusal ------------------------------

test("a manifest declaring zero holdout tests is refused, not scored as a pass", () => {
  const report: ScoreReport = {
    namespace: "capsid",
    run_id: "r",
    attempt_id: "a",
    head_sha: "h",
    jti: "j",
    anchors: { build_passes: 1 },
    secondary: { test_pass_rate: null, lint_count: null, error_count: null, p95_latency_ms: null, bundle_size_bytes: null },
    holdout: { total: 0, passed: 0 },
    ci_minutes: 0,
  };
  const verdict = checkHoldout({ namespace: "capsid", total: 0, updated_at: "2026-09-01T00:00:00Z" }, report);
  assert.equal(verdict.ok, false, "an empty hidden suite scored exactly like a passing one");
  assert.match(String(verdict.refusal), /zero|empty/i);
  assert.equal(verdict.passRate, null);
});

// ---- 10. the scorer's ids come from the Post step's own env -----------------

test("RUN_ID and ATTEMPT_ID are read only from the Post step's own env", () => {
  const yml = workflowText();
  const post = yml.slice(yml.indexOf("- name: Post the score report"));
  assert.ok(post.length > 100, "could not locate the Post step");
  const env = post.slice(post.indexOf("env:"), post.indexOf("run: |"));
  assert.match(env, /RUN_ID: \$\{\{ inputs\.run_id \}\}/, "RUN_ID is not bound in the Post step's own env");
  assert.match(env, /ATTEMPT_ID: \$\{\{ inputs\.attempt_id \}\}/, "ATTEMPT_ID is not bound in the Post step's own env");
  // And nothing anywhere in the workflow writes either id into GITHUB_ENV, which
  // is the cross-step injection the env placement exists to defeat.
  assert.ok(!/RUN_ID[^\n]*GITHUB_ENV/.test(yml), "a step writes RUN_ID into GITHUB_ENV");
  assert.ok(!/ATTEMPT_ID[^\n]*GITHUB_ENV/.test(yml), "a step writes ATTEMPT_ID into GITHUB_ENV");
});
