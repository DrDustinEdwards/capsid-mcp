import assert from "node:assert/strict";
import { test } from "node:test";
import { searchCode } from "../src/github.ts";
import { fakeEnv, fakeKv, withFetch, type FetchCall, type Route } from "./fakes.ts";

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

// Env and the HTTP stub come from ./fakes.ts (quality audit 6.2). The local
// withFetch here was the second of two copies; the shared one records every call,
// which is what this file's cap tests already needed, so the fetched-blob list is
// derived from the recorded calls rather than maintained separately.

function makeEnv() {
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) }) }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
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

// Builds the route map the shared stub takes. The stub records every call, so the
// list of blob paths actually requested is DERIVED from those calls rather than
// tracked separately: one source of truth for "what did the scan fetch".
//
// fetchedBlobs is how a cap is proven. files_scanned is the tool's own account of
// itself, and a cap reporting 1 while fetching 3 still burns three requests of the
// quota the cap exists to protect.
const blobsOf = (calls: FetchCall[], paths: string[]) =>
  calls
    .filter((c) => c.path.includes("/git/blobs/sha"))
    .map((c) => paths[Number(c.path.split("/git/blobs/sha")[1])]);

async function withTree(
  opts: { paths: string[]; contents: Record<string, string>; blobStatus?: Record<string, number> },
  fn: (calls: FetchCall[]) => Promise<void>
) {
  const routes: Record<string, Route> = {
    [`GET ${REPO_PATH}`]: { body: { default_branch: "main" } },
    [`GET ${TREE_PATH}`]: { body: tree(opts.paths) },
  };
  opts.paths.forEach((path, i) => {
    const status = opts.blobStatus?.[path];
    routes[`GET ${REPO_PATH}/git/blobs/sha${i}`] = status
      ? { status, body: { message: "boom" } }
      : { body: blob(opts.contents[path] ?? "") };
  });
  await withFetch(routes, fn);
}

test("a match is found when every blob is readable", async () => {
  await withTree(
    { paths: ["a.ts", "b.ts"], contents: { "a.ts": "const EMAIL_QUEUE = 1;", "b.ts": "nothing here" } },
    async () => {
      const r = (await searchCode(makeEnv(), "ns", "EMAIL_QUEUE")) as { total_results: number; items: unknown[] };
      assert.equal(r.total_results, 1);
      assert.equal(r.items.length, 1);
    }
  );
});

test("rate-limited blob fetch ABORTS the scan instead of returning empty", async () => {
  await withTree(
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
  await withTree(
    { paths: ["a.ts"], contents: { "a.ts": "x" }, blobStatus: { "a.ts": 429 } },
    async () => {
      await assert.rejects(() => searchCode(makeEnv(), "ns", "anything"), /aborted/i);
    }
  );
});

test("401 aborts too: a revoked token is not an empty repository", async () => {
  await withTree(
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
  await withTree(
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
  await withTree({ paths: ["a.ts"], contents: { "a.ts": "nothing" } }, async () => {
    const r = (await searchCode(makeEnv(), "ns", "EMAIL_QUEUE")) as {
      total_results: number;
      unreadable_files?: number;
    };
    assert.equal(r.total_results, 0);
    assert.equal(r.unreadable_files, undefined, "a genuinely empty result stays clean");
  });
});

// ---- the quota cap (quality audit 6.4) --------------------------------------
//
// max_files is the only thing standing between one search_code call and the App
// installation's hourly quota, because the cost is one HTTP request per candidate
// file FETCHED. The 5,000-entry tree refusal does not cover it: a tree of 4,000
// files is accepted and would be 4,000 blob GETs. Until now nothing tested the cap
// at all, so an off-by-one in `filesScanned >= maxFiles` would have shipped, and
// its symptom is quota exhaustion for every later call by any tool, not a wrong
// answer here.

const THREE = ["a.ts", "b.ts", "c.ts"];
const CONTENTS = { "a.ts": "needle here", "b.ts": "needle again", "c.ts": "needle third" };

test("max_files 1 stops after ONE blob and reports where to resume", async () => {
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", { maxFiles: 1 });
    // The cap is proven by the request that was not made.
    assert.deepEqual(blobsOf(calls, THREE), ["a.ts"], "the cap did not stop the scan: it fetched more than one blob");
    assert.equal(result.candidates, 3);
    assert.equal(result.files_scanned, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.next_start, 1, "next_start must name the first UNSEARCHED file");
    assert.match(result.note ?? "", /max_files cap \(1\)/);
    assert.match(result.note ?? "", /2 of 3 candidate files were not searched/);
  });
});

test("resuming at next_start scans the next file and nothing before it", async () => {
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", { maxFiles: 1, start: 1 });
    assert.deepEqual(blobsOf(calls, THREE), ["b.ts"], "a resumed scan re-read a file it had already searched");
    assert.equal(result.start, 1);
    assert.equal(result.files_scanned, 1);
    assert.equal(result.next_start, 2);
    assert.equal(result.items[0]?.path, "b.ts");
  });
});

test("the last page is not reported as truncated", async () => {
  // The boundary the off-by-one lives at: after the third file there is nothing
  // left, so truncated must be false and next_start must be absent. A cap that
  // reports more work when there is none sends a caller into an endless resume.
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", { maxFiles: 1, start: 2 });
    assert.deepEqual(blobsOf(calls, THREE), ["c.ts"]);
    assert.equal(result.truncated, false);
    assert.equal(result.next_start, undefined);
    assert.equal(result.note, undefined);
  });
});

test("max_results stops the scan too, and says more may exist", async () => {
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", { maxResults: 1 });
    assert.equal(result.total_results, 1);
    assert.deepEqual(blobsOf(calls, THREE), ["a.ts"], "the result cap did not stop the scan fetching further blobs");
    assert.equal(result.truncated, true);
    assert.match(result.note ?? "", /max_results cap/);
  });
});

test("an uncapped scan of the same tree reads everything, so the caps are what stopped it", async () => {
  // The negative control. Without it, every assertion above could be passing
  // because the fixture only ever had one readable file.
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", {});
    assert.deepEqual(blobsOf(calls, THREE), THREE);
    assert.equal(result.files_scanned, 3);
    assert.equal(result.total_results, 3);
    assert.equal(result.truncated, false);
  });
});
