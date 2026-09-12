import assert from "node:assert/strict";
import { test } from "node:test";
import { SELF_REPO, writeRepoFile } from "../src/github.ts";
import { pushAttempt } from "../src/improve-attempt.ts";
import { branchName } from "../src/improve-schema.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// THE CAPSID NAMESPACE COULD NOT MAKE AN ATTEMPT, audit 2026-09-07 (Opus MAJOR
// 5.3; Grok records the same collision inside its section 5 CLEAN list, noting
// that "file-changing attempts on capsid-mcp itself throw").
//
// `capsid` is on the improve roster and maps to whatever SELF_REPO names
// (DrDustinEdwards/capsid-mcp when this was written, DrDustinEdwards/capsid
// since the 2026-09-12 rename). pushAttempt commits with writeRepoFile(..., "direct",
// <attempt branch>), and commitOnBranch refused mode "direct" against the self
// repo REGARDLESS OF BRANCH. So every capsid attempt threw on its first file:
// the baseline dispatched and was scored, then startAttempt threw, the tick
// finalized the run with the error, and the night produced one wasted CI job.
// Every night, on a namespace with a pinned anchor and a 30-case holdout.
//
// The refusal exists to stop a production DEPLOY, and only the default branch
// deploys, so it is now scoped to the default branch in either mode.
//
// WHY 662 TESTS MISSED IT: the improve fixtures mapped capsid to
// "owner/capsid-mcp", one word away from the real mapping and therefore never
// equal to SELF_REPO. Those fixtures now use the real owner, and this file
// drives the push that no test drove at all.
//
// TAKEN FROM SELF_REPO, NOT SPELLED OUT. A hardcoded copy here is the same
// defect this file was written about: the rename on 2026-09-12 would have put
// this constant one word away from the real mapping again, and every assertion
// below would have gone quiet rather than red. The literal value is pinned in
// exactly one place, repo-name.test.ts.
const SELF = SELF_REPO;

function selfRepoEnv() {
  const kv = fakeKv({ seedToken: true });
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: SELF, label: "primary" }]) }) }),
      }),
    },
    APP_KV: kv.kv,
  });
}

const ROUTES = {
  [`GET /repos/${SELF}`]: { body: { default_branch: "master" } },
  [`POST /repos/${SELF}/git/refs`]: { status: 201, body: {} },
  [`GET /repos/${SELF}/contents/src/links.ts`]: { status: 404, body: {} },
  [`PUT /repos/${SELF}/contents/src/links.ts`]: {
    body: { commit: { sha: "c0ffee1234567890abcdef1234567890abcdef12" }, content: { sha: "f11e5ha" } },
  },
};

test("PLANT: an improve attempt CAN be pushed to the self repo's attempt branch", async () => {
  await withFetch(ROUTES, async (calls) => {
    const result = await pushAttempt(selfRepoEnv(), {
      namespace: "capsid",
      branch: branchName("capsid-2026-09-07-a01"),
      baseSha: "ba5e0000000000000000000000000000000000ba",
      summary: "a scoped change",
      files: [{ path: "src/links.ts", content: "export const x = 1;\n" }],
    });
    assert.equal(result.headSha, "c0ffee1234567890abcdef1234567890abcdef12", "the commit must land");
    assert.deepEqual(result.changedPaths, ["src/links.ts"]);
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put, "a file must actually have been committed");
    assert.match(String(put.path), /contents\/src\/links\.ts/);
    const body = put.body as { branch?: string };
    assert.equal(body.branch, "improve/capsid-2026-09-07-a01", "and it must land on the attempt branch, not master");
  });
});

test("the self-repo refusal still holds where it matters: the default branch", async () => {
  // Both modes, because a pr-mode work branch equal to the default branch is a
  // direct write with extra steps.
  await withFetch(ROUTES, async () => {
    await assert.rejects(
      () => writeRepoFile(selfRepoEnv(), "capsid", "src/x.ts", "x", "m", "direct"),
      /default branch/,
      "direct mode with no branch targets master and must be refused"
    );
    await assert.rejects(
      () => writeRepoFile(selfRepoEnv(), "capsid", "src/x.ts", "x", "m", "direct", "master"),
      /default branch/,
      "direct mode naming master must be refused"
    );
    await assert.rejects(
      () => writeRepoFile(selfRepoEnv(), "capsid", "src/x.ts", "x", "m", "pr", "master"),
      /default branch/,
      "pr mode whose work branch IS master must be refused"
    );
  });
});

test("a non-default branch on the self repo is writable in direct mode", async () => {
  // This is what the old refusal took away. A work branch is not a deploy.
  await withFetch(ROUTES, async (calls) => {
    const res = (await writeRepoFile(
      selfRepoEnv(),
      "capsid",
      "src/links.ts",
      "export const x = 1;\n",
      "m",
      "direct",
      "improve/capsid-2026-09-07-a01"
    )) as { commitSha?: string };
    assert.equal(res.commitSha, "c0ffee1234567890abcdef1234567890abcdef12");
    assert.ok(calls.some((c) => c.method === "PUT"));
  });
});

test("PLANT: pushAttempt refuses any branch that is not an improve branch", async () => {
  // writeRepoFile's direct mode falls back to the DEFAULT branch when no branch
  // is passed, so the loop's safety rests on the branch argument being present.
  // On capsid that default branch is this server's own master, and a dropped
  // branch would be a production deploy rather than a bad attempt.
  for (const branch of ["", "master", "main", "feature/x"]) {
    await withFetch(ROUTES, async (calls) => {
      await assert.rejects(
        () =>
          pushAttempt(selfRepoEnv(), {
            namespace: "capsid",
            branch,
            baseSha: "ba5e",
            summary: "s",
            files: [{ path: "src/links.ts", content: "x" }],
          }),
        /not an improve-loop branch/,
        `pushAttempt must refuse '${branch}'`
      );
      assert.equal(calls.length, 0, "the refusal must cost no GitHub round trip");
    });
  }
});

test("a baseline push (no files) still works and creates only the branch", async () => {
  await withFetch(ROUTES, async (calls) => {
    const result = await pushAttempt(selfRepoEnv(), {
      namespace: "capsid",
      branch: branchName("capsid-2026-09-07-baseline"),
      baseSha: "ba5e0000000000000000000000000000000000ba",
      summary: "baseline",
      files: [],
    });
    assert.equal(result.headSha, "ba5e0000000000000000000000000000000000ba", "no commit, so head stays at the base");
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
    assert.ok(calls.some((c) => c.method === "POST" && String(c.path).includes("/git/refs")), "the branch is created");
  });
});
