import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deleteBranch,
  encodePath,
  parseReposList,
  readRepoFile,
  repoTokenOk,
  writeRepoFile,
} from "../src/github.ts";
import { repoPathProblem } from "../src/limits.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// These tests exist for the 2026-09-06 CRITICAL: a repo file path or branch
// carrying "../.." escaped /repos/<owner>/<repo>/ once fetch() parsed the string
// as a URL, reaching any repo the App is installed on under the same owner. The
// point the audit made is that a fake fetch keyed on the RAW concatenated string
// cannot see the escape, because WHATWG normalization happens inside new URL().
// So the integration tests below build the URL through the real code path and read
// the RECORDED call's normalized pathname, which is where the escape shows.

function makeEnv(repos: unknown[]) {
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify(repos) }) }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

const ONE_REPO = [{ repo: "owner/mapped-repo", label: "primary" }];

// ---- the escape is real (documents the vulnerability) -----------------------

test("WHATWG normalization walks '..' out of the mapped repo prefix", () => {
  // This is the raw string the OLD encodePath produced: real slashes, real "..".
  const raw = "/repos/owner/mapped-repo/contents/" + "../../other-repo/contents/secrets.env";
  const { pathname } = new URL(`https://api.github.com${raw}`);
  // Proof the concatenation escapes: the parsed pathname names a DIFFERENT repo.
  assert.equal(pathname, "/repos/owner/other-repo/contents/secrets.env");
  assert.ok(!pathname.startsWith("/repos/owner/mapped-repo/"));
});

// ---- the input-level guard --------------------------------------------------

test("repoPathProblem rejects '.' and '..' segments and control chars", () => {
  assert.ok(repoPathProblem("../../x"));
  assert.ok(repoPathProblem("a/../b"));
  assert.ok(repoPathProblem("./x"));
  assert.ok(repoPathProblem("a/b/.."));
  assert.ok(repoPathProblem("x/\n/y"));
  assert.ok(repoPathProblem("/leading"));
  assert.ok(repoPathProblem("trailing/"));
  assert.ok(repoPathProblem("a//b"));
});

test("repoPathProblem allows real repo paths, including dotted and dotfile names", () => {
  assert.equal(repoPathProblem(".github/workflows/improve-score.yml"), null);
  assert.equal(repoPathProblem(".npmrc"), null);
  assert.equal(repoPathProblem("src/foo.test.ts"), null);
  assert.equal(repoPathProblem("a..b/c"), null); // "a..b" is a legal name; only a whole ".." segment moves the URL
  assert.equal(repoPathProblem("README.md"), null);
});

// ---- encodePath now refuses a traversal segment -----------------------------

test("encodePath throws on a '..' segment (old code returned it verbatim)", () => {
  assert.throws(() => encodePath("../../x"), /'\.\.' segment/);
  assert.throws(() => encodePath("a/./b"), /'\.' segment/);
  // Still encodes ordinary paths.
  assert.equal(encodePath("a/b c/d.md"), "a/b%20c/d.md");
});

// ---- REPO_SHAPE no longer admits a traversal mapping ------------------------

test("repoTokenOk and parseReposList reject '..' as an owner/name mapping", () => {
  assert.equal(repoTokenOk("../evil"), false);
  assert.equal(repoTokenOk("owner/.."), false);
  assert.equal(repoTokenOk("owner/repo"), true);
  // OLD REPO_SHAPE /^[^/\s]+\/[^/\s]+$/ matched "../evil"; the new mapping refuses it.
  const bad = parseReposList(JSON.stringify([{ repo: "../evil", label: "primary" }]));
  assert.ok("error" in bad);
  const good = parseReposList(JSON.stringify([{ repo: "owner/repo", label: "primary" }]));
  assert.ok("list" in good);
});

// ---- integration: the traversal never reaches GitHub ------------------------

test("read_repo_file refuses a traversal path and makes no escaping request", async () => {
  await withFetch(
    {
      // If the OLD code ran, cachedGet would fetch this normalized URL and return
      // the secret; the test would then NOT reject and would fail.
      "GET /repos/owner/other-repo/contents/secrets.env": {
        body: { type: "file", encoding: "base64", content: Buffer.from("SECRET").toString("base64"), size: 6, sha: "x" },
      },
    },
    async (calls) => {
      await assert.rejects(
        () => readRepoFile(makeEnv(ONE_REPO), "ns", "../../other-repo/contents/secrets.env"),
        /path segment|escapes \/repos/
      );
      // No request escaped the mapped repo. On old code, a call to
      // /repos/owner/other-repo/... would be recorded here.
      for (const c of calls) {
        assert.ok(
          c.path.startsWith("/repos/owner/mapped-repo/") || c.path.startsWith("/app/") || c.path === "/repos/owner/mapped-repo",
          `unexpected escaping request to ${c.path}`
        );
      }
    }
  );
});

test("write_repo_file refuses a traversal path and makes no escaping request", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => writeRepoFile(makeEnv(ONE_REPO), "ns", "../../other-repo/contents/x", "body", "msg", "direct"),
      /path segment|escapes \/repos/
    );
    for (const c of calls) {
      assert.ok(!c.path.includes("/other-repo/"), `unexpected escaping request to ${c.path}`);
    }
  });
});

test("delete_branch refuses a traversal branch and makes no escaping request", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => deleteBranch(makeEnv(ONE_REPO), "ns", "../../tags/v1"),
      /path segment|escapes \/repos/
    );
    for (const c of calls) {
      assert.ok(!c.path.includes("/tags/"), `unexpected escaping request to ${c.path}`);
    }
  });
});
