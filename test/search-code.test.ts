import assert from "node:assert/strict";
import { test } from "node:test";
import { searchCode } from "../src/github.ts";

// search_code walks a repo tree and greps every blob, one HTTP request per
// candidate file. That makes it the tool most likely to run out of GitHub quota
// mid-scan, and until 2026-08-11 it handled that by silently skipping the blob:
//
//   const blob = await ghFetch(...);
//   if (!blob.ok) continue;
//
// So an exhausted rate limit produced total_results 0 with truncated false over
// a repository it had not read. Measured on 2026-08-10: a scan for EMAIL_QUEUE
// across foxhound returned zero while that string sat on three lines of
// app/lib/email/dispatch.ts, and two downstream reports were written against
// that false negative before it was caught.
//
// These tests fix the distinction the tool must preserve: "not found" and
// "could not check" are different answers, and only one of them is a finding.

function makeEnv() {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) }) }),
      }),
    },
    APP_KV: {
      get: async (k: string) => (k.startsWith("gh:token:") ? "test-token" : null),
      put: async () => {},
      delete: async () => {},
    },
  } as never;
}

const TREE_PATH = "/repos/owner/repo/git/trees/main";
const REPO_PATH = "/repos/owner/repo";

function tree(paths: string[]) {
  return {
    truncated: false,
    tree: paths.map((p, i) => ({ path: p, type: "blob", sha: `sha${i}`, size: 100 })),
  };
}

function blob(text: string) {
  return { encoding: "base64", content: Buffer.from(text, "utf8").toString("base64") };
}

// Routes by pathname; blobStatus lets a test fail specific blob fetches.
async function withFetch(
  opts: { paths: string[]; contents: Record<string, string>; blobStatus?: Record<string, number> },
  fn: () => Promise<void>
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const { pathname } = new URL(url);
    if (pathname === REPO_PATH) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (pathname === TREE_PATH) return new Response(JSON.stringify(tree(opts.paths)), { status: 200 });
    const m = pathname.match(/\/git\/blobs\/sha(\d+)$/);
    if (m) {
      const path = opts.paths[Number(m[1])];
      const status = opts.blobStatus?.[path];
      if (status) return new Response(JSON.stringify({ message: "boom" }), { status });
      return new Response(JSON.stringify(blob(opts.contents[path] ?? "")), { status: 200 });
    }
    return new Response("unrouted", { status: 500 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("a match is found when every blob is readable", async () => {
  await withFetch(
    { paths: ["a.ts", "b.ts"], contents: { "a.ts": "const EMAIL_QUEUE = 1;", "b.ts": "nothing here" } },
    async () => {
      const r = (await searchCode(makeEnv(), "ns", "EMAIL_QUEUE")) as { total_results: number; items: unknown[] };
      assert.equal(r.total_results, 1);
      assert.equal(r.items.length, 1);
    }
  );
});

test("rate-limited blob fetch ABORTS the scan instead of returning empty", async () => {
  await withFetch(
    {
      paths: ["a.ts", "b.ts"],
      contents: { "a.ts": "const EMAIL_QUEUE = 1;", "b.ts": "x" },
      // The exact shape of the 2026-08-10 incident: the tree resolves, then
      // every blob fetch is refused for quota.
      blobStatus: { "a.ts": 403, "b.ts": 403 },
    },
    async () => {
      await assert.rejects(
        () => searchCode(makeEnv(), "ns", "EMAIL_QUEUE"),
        (err: Error) => {
          assert.match(err.message, /aborted/i, "must say the scan aborted");
          assert.match(err.message, /NOT an empty result/i, "must refuse to be read as a negative finding");
          assert.match(err.message, /403/, "must name the status");
          return true;
        }
      );
    }
  );
});

test("429 aborts too", async () => {
  await withFetch(
    { paths: ["a.ts"], contents: { "a.ts": "x" }, blobStatus: { "a.ts": 429 } },
    async () => {
      await assert.rejects(() => searchCode(makeEnv(), "ns", "anything"), /aborted/i);
    }
  );
});

test("401 aborts too: a revoked token is not an empty repository", async () => {
  await withFetch(
    { paths: ["a.ts"], contents: { "a.ts": "x" }, blobStatus: { "a.ts": 401 } },
    async () => {
      await assert.rejects(() => searchCode(makeEnv(), "ns", "anything"), /aborted/i);
    }
  );
});

test("a survivable per-file error does NOT abort, but is reported", async () => {
  // A 404 on one blob (a raced deletion) is genuinely per-file, so the scan
  // continues. It must still be visible: "0 results over 2 files" and "0 results
  // over 2 files, 1 unreadable" are different claims.
  await withFetch(
    {
      paths: ["gone.ts", "here.ts"],
      contents: { "here.ts": "const EMAIL_QUEUE = 1;" },
      blobStatus: { "gone.ts": 404 },
    },
    async () => {
      const r = (await searchCode(makeEnv(), "ns", "EMAIL_QUEUE")) as {
        total_results: number;
        unreadable_files?: number;
        unreadable_sample?: string[];
      };
      assert.equal(r.total_results, 1, "the readable file still matches");
      assert.equal(r.unreadable_files, 1, "the unreadable file is counted");
      assert.deepEqual(r.unreadable_sample, ["gone.ts"], "and named");
    }
  );
});

test("a clean zero-result scan reports no unreadable files at all", async () => {
  // Guards the guard: if unreadable_files were always set, the field above would
  // prove nothing.
  await withFetch({ paths: ["a.ts"], contents: { "a.ts": "nothing" } }, async () => {
    const r = (await searchCode(makeEnv(), "ns", "EMAIL_QUEUE")) as {
      total_results: number;
      unreadable_files?: number;
    };
    assert.equal(r.total_results, 0);
    assert.equal(r.unreadable_files, undefined, "a genuinely empty result stays clean");
  });
});
