import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ciStatus,
  createBranch,
  deleteRepoFile,
  managePr,
  parseReposList,
  readRepoFile,
  requireSinglePrimary,
  resolveRepo,
  writeRepoFile,
} from "../src/github.ts";
import { fakeEnv, fakeKv, withFetch, type Route } from "./fakes.ts";

// KV, Env and the HTTP stub all come from ./fakes.ts now (quality audit 6.2).
// This file's local KV was the only one that parsed the "json" get type, seeded a
// default installation token and supported list; all three survive the merge, and
// the shared one adds failure injection and cursor pagination.

function makeEnv(repos: unknown[] | null, kv = fakeKv({ seedToken: true }), extra: Record<string, unknown> = {}) {
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => (repos === null ? null : { repos: JSON.stringify(repos) }) }),
      }),
    },
    APP_KV: kv.kv,
    ...extra,
  });
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const fileBody = (content: string, sha = "file-sha") => ({
  type: "file",
  encoding: "base64",
  content: b64(content),
  size: content.length,
  sha,
});

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

// ---- read cache invalidation (F15) ------------------------------------------

const ONE_REPO = [{ repo: "o/r", label: "primary" }];
const READ_PREFIX = "gh:get:/repos/o/r/";

test("a read after a write returns the new content, not the cached body", async () => {
  // The end-to-end shape of the finding: read (caches), write, read again inside
  // the 60 second TTL. The second read used to serve the body the write replaced.
  const kv = fakeKv({ seedToken: true });
  const env = makeEnv(ONE_REPO, kv);
  let content = "OLD";
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/contents/doc.md": () => ({ body: fileBody(content) }),
      "PUT /repos/o/r/contents/doc.md": (requestBody) => {
        content = Buffer.from((requestBody as { content: string }).content, "base64").toString("utf8");
        return { body: { commit: { sha: "commit-sha" }, content: { sha: "new-file-sha" } } };
      },
    },
    async () => {
      const first = await readRepoFile(env, "ns", "doc.md");
      assert.equal(first.content, "OLD");
      assert.ok(kv.keysUnder(READ_PREFIX).length > 0, "the read did not cache, so this test proves nothing");

      await writeRepoFile(env, "ns", "doc.md", "NEW", "msg", "direct");

      const second = await readRepoFile(env, "ns", "doc.md");
      assert.equal(second.content, "NEW");
    }
  );
});

test("every mutating path invalidates that repo's cached reads", async () => {
  // One case per mutating call site that changes what a read would return. A site
  // added later that skips invalidation is what this table exists to catch.
  const cases: Array<{ name: string; run: (env: never) => Promise<unknown> }> = [
    { name: "write_repo_file direct", run: (env) => writeRepoFile(env, "ns", "doc.md", "NEW", "m", "direct") },
    { name: "write_repo_file pr", run: (env) => writeRepoFile(env, "ns", "doc.md", "NEW", "m", "pr") },
    { name: "delete_repo_file direct", run: (env) => deleteRepoFile(env, "ns", "doc.md", "m", "direct") },
    { name: "delete_repo_file pr", run: (env) => deleteRepoFile(env, "ns", "doc.md", "m", "pr") },
    { name: "manage_pr merge", run: (env) => managePr(env, "ns", 5, "merge") },
  ];
  for (const c of cases) {
    const kv = fakeKv({ seedToken: true });
    const env = makeEnv(ONE_REPO, kv);
    // Two cached reads of this repo, plus one of a DIFFERENT repo under the same
    // owner: the sweep must be scoped to o/r and must not take o/rr with it.
    kv.store.set("gh:get:/repos/o/r/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
    kv.store.set("gh:get:/repos/o/r/contents/?ref=main", JSON.stringify({ status: 200, body: "[]" }));
    kv.store.set("gh:get:/repos/o/rr/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
    await withFetch(
      {
        "GET /repos/o/r": { body: { default_branch: "main" } },
        "GET /repos/o/r/git/ref/heads/main": { body: { object: { sha: "head-sha" } } },
        "POST /repos/o/r/git/refs": { status: 201, body: {} },
        "GET /repos/o/r/contents/doc.md": { body: fileBody("OLD") },
        "PUT /repos/o/r/contents/doc.md": { body: { commit: { sha: "c" }, content: { sha: "f" } } },
        "DELETE /repos/o/r/contents/doc.md": { body: { commit: { sha: "c" } } },
        "POST /repos/o/r/pulls": { status: 201, body: { number: 7, html_url: "https://pr" } },
        "PUT /repos/o/r/pulls/5/merge": { body: { sha: "s", merged: true, message: "merged" } },
      },
      async () => {
        await c.run(env);
        assert.deepEqual(kv.keysUnder(READ_PREFIX), [], `${c.name} left a stale cache entry`);
        assert.deepEqual(
          kv.keysUnder("gh:get:/repos/o/rr/"),
          ["gh:get:/repos/o/rr/contents/doc.md"],
          `${c.name} swept a different repo's cache`
        );
      }
    );
  }
});

test("a call that changes no content leaves the cache alone", async () => {
  // The innocent case. A sweep that fires on everything would pass the tests above
  // while quietly making the cache useless, so both directions are checked.
  for (const c of [
    { name: "manage_pr close", run: (env: never) => managePr(env, "ns", 5, "close") },
    { name: "create_branch", run: (env: never) => createBranch(env, "ns", "wip") },
  ]) {
    const kv = fakeKv({ seedToken: true });
    const env = makeEnv(ONE_REPO, kv);
    kv.store.set("gh:get:/repos/o/r/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
    await withFetch(
      {
        "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
        "GET /repos/o/r": { body: { default_branch: "main" } },
        "GET /repos/o/r/git/ref/heads/main": { body: { object: { sha: "head-sha" } } },
        "POST /repos/o/r/git/refs": { status: 201, body: {} },
      },
      async () => {
        await c.run(env);
        assert.deepEqual(kv.keysUnder(READ_PREFIX), ["gh:get:/repos/o/r/contents/doc.md"], `${c.name} swept the cache`);
      }
    );
  }
});

test("reads of different refs are different cache entries", async () => {
  // The key carries the ref as a literal query, so a branch read cannot be served
  // from the default branch's entry. Stated as a test because the invalidation
  // design depends on it.
  const kv = fakeKv({ seedToken: true });
  const env = makeEnv(ONE_REPO, kv);
  await withFetch(
    {
      "GET /repos/o/r/contents/doc.md": (_b) => ({ body: fileBody("whatever") }),
    },
    async () => {
      await readRepoFile(env, "ns", "doc.md");
      await readRepoFile(env, "ns", "doc.md", "wip");
      assert.deepEqual(kv.keysUnder(READ_PREFIX).sort(), [
        "gh:get:/repos/o/r/contents/doc.md",
        "gh:get:/repos/o/r/contents/doc.md?ref=wip",
      ]);
    }
  );
});

// ---- per-owner installation resolution (F20) --------------------------------

// A real key, so createAppJwt and importPrivateKey run rather than being stubbed
// around. Generated once for the file.
let pemPromise: Promise<string> | null = null;
function testPem(): Promise<string> {
  pemPromise ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let binary = "";
    for (const byte of der) binary += String.fromCharCode(byte);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  })();
  return pemPromise;
}

test("the installation id is resolved per owner, and a pinned id is not consulted", async () => {
  // Two owners in one namespace mapping, one KV, one env carrying the retired
  // GITHUB_APP_INSTALLATION_ID. One id cannot be right for both, which is the
  // finding: the pin was written under whichever owner asked.
  const kv = fakeKv({ seedToken: false });
  const env = makeEnv(
    [
      { repo: "a/ra", label: "primary" },
      { repo: "b/rb", label: "second" },
    ],
    kv,
    {
      GITHUB_APP_CLIENT_ID: "Iv1.test",
      GITHUB_APP_PRIVATE_KEY: await testPem(),
      GITHUB_APP_INSTALLATION_ID: "999",
    }
  );
  await withFetch(
    {
      "GET /repos/a/ra/installation": { body: { id: 111 } },
      "GET /repos/b/rb/installation": { body: { id: 222 } },
      "POST /app/installations/111/access_tokens": { body: { token: "token-for-111" } },
      "POST /app/installations/222/access_tokens": { body: { token: "token-for-222" } },
      "GET /repos/a/ra/contents/doc.md": { body: fileBody("a") },
      "GET /repos/b/rb/contents/doc.md": { body: fileBody("b") },
    },
    async (calls) => {
      await readRepoFile(env, "ns", "doc.md");
      await readRepoFile(env, "ns", "doc.md", undefined, "second");

      const minted = calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.path);
      assert.deepEqual(minted.sort(), [
        "/app/installations/111/access_tokens",
        "/app/installations/222/access_tokens",
      ]);
      assert.equal(
        minted.some((p) => p.includes("/999/")),
        false,
        "the retired pinned installation id was used to mint a token"
      );
      assert.equal(kv.store.get("gh:install:v2:a"), "111");
      assert.equal(kv.store.get("gh:install:v2:b"), "222");
    }
  );
});

test("a 404 on installation resolution says the credentials are fine", async () => {
  const env = makeEnv(ONE_REPO, fakeKv({ seedToken: false }), {
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_PRIVATE_KEY: await testPem(),
  });
  await withFetch({ "GET /repos/o/r/installation": { status: 404, body: { message: "Not Found" } } }, async () => {
    await assert.rejects(() => readRepoFile(env, "ns", "doc.md"), /not installed on this repo/);
  });
});

// ---- ci_status degraded shapes (F34) ----------------------------------------

const FAILED_RUNS = {
  workflow_runs: [
    {
      id: 42,
      name: "CI",
      head_sha: "abcdef1234",
      status: "completed",
      conclusion: "failure",
      event: "push",
      created_at: "2026-08-17T00:00:00Z",
      html_url: "https://run",
    },
  ],
};
const JOBS_OK = {
  jobs: [{ id: 9, name: "check", conclusion: "failure", steps: [{ name: "npm test", conclusion: "failure" }] }],
};
type FailedRun = {
  jobs?: unknown;
  jobs_unavailable?: string;
  log_tail?: string;
  log_tail_unavailable?: string;
  log_tail_withheld?: string;
};

test("ci_status names an unavailable jobs fetch instead of dropping failed_run", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { status: 500, text: "upstream boom" },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.ok(failed, "failed_run was dropped entirely");
      assert.match(failed.jobs_unavailable ?? "", /^500: upstream boom/);
      assert.equal(failed.jobs, undefined);
    }
  );
});

test("ci_status names an unavailable log fetch for a write-grant caller", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
      "GET /repos/o/r/actions/jobs/9/logs": { status: 410, text: "log expired" },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.match(failed.log_tail_unavailable ?? "", /^410: log expired/);
      assert.equal(failed.log_tail, undefined);
      // Not the read-only message: this caller was allowed the log and did not get one.
      assert.equal(failed.log_tail_withheld, undefined);
    }
  );
});

test("ci_status still withholds the log tail from a read-only key", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
    },
    async (calls) => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: false });
      const failed = result.failed_run as FailedRun;
      assert.match(failed.log_tail_withheld ?? "", /read-only key/);
      assert.equal(failed.log_tail, undefined);
      assert.equal(failed.log_tail_unavailable, undefined);
      // And the log was never fetched, so it cannot leak by another route.
      assert.equal(calls.some((c) => c.path.includes("/logs")), false);
    }
  );
});

test("ci_status returns the log tail when it can", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
      "GET /repos/o/r/actions/jobs/9/logs": { text: "the last line" },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.equal(failed.log_tail, "the last line");
      assert.equal(failed.log_tail_unavailable, undefined);
    }
  );
});

test("ci_status names the case where a failed run has no failed job", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: { jobs: [{ id: 9, name: "check", conclusion: "cancelled" }] } },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.match(failed.log_tail_unavailable ?? "", /no job in it is/);
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

// ---- F25: a corrupt repos row fails closed ----------------------------------

test("resolveRepo names a corrupt repos mapping instead of reporting none", async () => {
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: "{not json" }) }) }) },
    APP_KV: fakeKv().kv,
  } as never;
  await assert.rejects(() => resolveRepo(env, "ns"), /CORRUPT repos mapping/);
});

test("resolveRepo refuses a repos value that parses but is not an array", async () => {
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: '{"repo":"o/r"}' }) }) }) },
    APP_KV: fakeKv().kv,
  } as never;
  await assert.rejects(() => resolveRepo(env, "ns"), /CORRUPT repos mapping/);
});

test("an empty mapping still reports as unconfigured, not as corrupt", async () => {
  // The two states must stay distinguishable in both directions, or the fix has
  // just moved the confusion.
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: "[]" }) }) }) },
    APP_KV: fakeKv().kv,
  } as never;
  await assert.rejects(() => resolveRepo(env, "ns"), /has no repo mapping/);
});
