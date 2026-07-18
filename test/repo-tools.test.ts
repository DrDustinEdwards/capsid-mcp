import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deleteRepoFile,
  managePr,
  parseReposList,
  requireSinglePrimary,
  resolveRepo,
} from "../src/github.ts";

// Minimal Env stub. resolveRepo reads DB; the write paths also read APP_KV for a
// cached installation token (seeded here so no JWT is minted) and hit GitHub via
// global fetch, which each test stubs.
function makeEnv(repos: unknown[] | null) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => (repos === null ? null : { repos: JSON.stringify(repos) }) }),
      }),
    },
    APP_KV: {
      get: async (k: string) => (k.startsWith("gh:token:") ? "test-token" : null),
      put: async () => {},
      delete: async () => {},
    },
  } as never;
}

// Route GitHub calls by "METHOD pathname" (query ignored) to a canned response.
// Records the calls so a test can assert the request body that was sent.
async function withFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
  fn: (calls: Array<{ method: string; path: string; body: unknown }>) => Promise<void> | void
) {
  const original = globalThis.fetch;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    calls.push({
      method,
      path: parsed.pathname,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const route = routes[`${method} ${parsed.pathname}`];
    if (!route) return new Response(`no route for ${method} ${parsed.pathname}`, { status: 500 });
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// ---- repo selector resolution -----------------------------------------------

const TWO_REPOS = [
  { repo: "owner/primary-repo", label: "primary" },
  { repo: "owner/legacy-repo", label: "legacy" },
];

test("resolveRepo selects by label", async () => {
  const ref = await resolveRepo(makeEnv(TWO_REPOS), "ns", "legacy");
  assert.equal(ref.full, "owner/legacy-repo");
});

test("resolveRepo selects by full owner/name", async () => {
  const ref = await resolveRepo(makeEnv(TWO_REPOS), "ns", "owner/legacy-repo");
  assert.equal(ref.full, "owner/legacy-repo");
});

test("resolveRepo defaults to the primary when no selector is given", async () => {
  const ref = await resolveRepo(makeEnv(TWO_REPOS), "ns");
  assert.equal(ref.full, "owner/primary-repo");
});

test("resolveRepo rejects an unmapped selector with the valid values", async () => {
  await assert.rejects(
    () => resolveRepo(makeEnv(TWO_REPOS), "ns", "owner/somewhere-else"),
    /not mapped to namespace ns.*owner\/primary-repo/s
  );
});

test("resolveRepo rejects an unknown namespace", async () => {
  await assert.rejects(() => resolveRepo(makeEnv(null), "ghost"), /unknown namespace: ghost/);
});

// ---- namespace repos validation ---------------------------------------------

test("parseReposList accepts a valid array and defaults the label to primary", () => {
  const result = parseReposList('[{"repo":"a/b"}]');
  assert.deepEqual(result, { list: [{ repo: "a/b", label: "primary" }] });
});

test("parseReposList rejects a non-array", () => {
  const result = parseReposList('{"repo":"a/b"}');
  assert.ok("error" in result && /non-empty JSON array/.test(result.error));
});

test("parseReposList rejects an empty array", () => {
  const result = parseReposList("[]");
  assert.ok("error" in result && /non-empty JSON array/.test(result.error));
});

test("parseReposList rejects a malformed owner/name", () => {
  const result = parseReposList('[{"repo":"not-a-repo"}]');
  assert.ok("error" in result && /owner\/name/.test(result.error));
});

test("parseReposList rejects invalid JSON", () => {
  const result = parseReposList("{not json");
  assert.ok("error" in result && /invalid repos JSON/.test(result.error));
});

test("requireSinglePrimary demands exactly one primary", () => {
  assert.equal(requireSinglePrimary([{ repo: "a/b", label: "primary" }]), null);
  assert.ok(requireSinglePrimary([{ repo: "a/b", label: "legacy" }])?.includes("found 0"));
  assert.ok(
    requireSinglePrimary([
      { repo: "a/b", label: "primary" },
      { repo: "a/c", label: "primary" },
    ])?.includes("found 2")
  );
});

// ---- delete_repo_file: mode + precondition ----------------------------------

test("delete_repo_file direct mode deletes on the default branch", async () => {
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/contents/doc.md": { body: { sha: "file-sha" } },
      "DELETE /repos/o/r/contents/doc.md": { body: { commit: { sha: "commit-sha" } } },
    },
    async (calls) => {
      const result = await deleteRepoFile(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", "doc.md", "remove it", "direct");
      assert.deepEqual(result, {
        repo: "o/r",
        mode: "direct",
        branch: "main",
        path: "doc.md",
        commitSha: "commit-sha",
      });
      const del = calls.find((c) => c.method === "DELETE");
      assert.equal((del?.body as { sha: string }).sha, "file-sha");
      assert.equal((del?.body as { branch: string }).branch, "main");
    }
  );
});

test("delete_repo_file errors clearly when the file does not exist", async () => {
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/contents/gone.md": { status: 404, body: { message: "Not Found" } },
    },
    async () => {
      await assert.rejects(
        () => deleteRepoFile(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", "gone.md", "msg", "direct"),
        /does not exist on o\/r@main/
      );
    }
  );
});

test("delete_repo_file pr mode opens a branch and a PR", async () => {
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/git/ref/heads/main": { body: { object: { sha: "head-sha" } } },
      "POST /repos/o/r/git/refs": { status: 201, body: {} },
      "GET /repos/o/r/contents/doc.md": { body: { sha: "file-sha" } },
      "DELETE /repos/o/r/contents/doc.md": { body: { commit: { sha: "commit-sha" } } },
      "POST /repos/o/r/pulls": { status: 201, body: { number: 7, html_url: "https://pr" } },
    },
    async () => {
      const result = (await deleteRepoFile(
        makeEnv([{ repo: "o/r", label: "primary" }]),
        "ns",
        "doc.md",
        "remove it",
        "pr"
      )) as { mode: string; branch: string; pr: { number: number } };
      assert.equal(result.mode, "pr");
      assert.ok(result.branch.startsWith("capsid/rm-"));
      assert.equal(result.pr.number, 7);
    }
  );
});

// ---- manage_pr: action routing ----------------------------------------------

test("manage_pr merge calls the merge endpoint and returns the merged sha", async () => {
  await withFetch(
    { "PUT /repos/o/r/pulls/5/merge": { body: { sha: "merged-sha", merged: true, message: "merged" } } },
    async (calls) => {
      const result = await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "merge", "squash");
      assert.deepEqual(result, {
        repo: "o/r",
        number: 5,
        action: "merge",
        merged: true,
        sha: "merged-sha",
        message: "merged",
      });
      assert.equal((calls[0].body as { merge_method: string }).merge_method, "squash");
    }
  );
});

test("manage_pr close patches the PR state to closed", async () => {
  await withFetch(
    { "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } } },
    async (calls) => {
      const result = await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "close");
      assert.deepEqual(result, { repo: "o/r", number: 5, action: "close", state: "closed", url: "https://pr" });
      assert.equal((calls[0].body as { state: string }).state, "closed");
    }
  );
});
