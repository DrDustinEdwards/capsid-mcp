import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_PREFIX, VERDICTS, decidingReview, outcomeOf, pullRequestFrom, readReviewComments, verdictOf } from "../src/review.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// GROUP 4: A SECOND READER BEFORE THE SEAT.
//
// The envelope is strict on purpose, so these tests spend most of their length on
// what is NOT a review. A parser that guessed at intent would be guessing on the one
// decision in this system allowed to send work back, and a wrong guess would look
// exactly like a review that happened.

const at = (iso: string) => ({ user: "reviewer", created_at: iso, body: "" });
const comment = (body: string, iso = "2026-09-12T10:00:00Z", user = "reviewer") => ({ user, created_at: iso, body });

test("the three verdicts are the three the job named", () => {
  assert.deepEqual([...VERDICTS], ["APPROVE", "CHANGES", "BLOCK"]);
  assert.equal(REVIEW_PREFIX, "REVIEW:");
});

test("a well-formed review of each verdict parses", () => {
  for (const verdict of VERDICTS) {
    const parsed = verdictOf(comment(`REVIEW: the scope check looks right to me. ${verdict}`));
    assert.ok(parsed, `${verdict} did not parse`);
    assert.equal(parsed.verdict, verdict);
    // The reviewer's own punctuation is kept. Stripping the full stop would be this
    // parser editing what somebody wrote, and `said` exists to carry it verbatim.
    assert.equal(parsed.said, "the scope check looks right to me.");
    assert.equal(parsed.by, "reviewer");
  }
});

test("the verdict survives the punctuation and formatting a person actually writes", () => {
  for (const body of ["REVIEW: fine. APPROVE.", "REVIEW: fine **APPROVE**", "REVIEW: fine `APPROVE`", "REVIEW: fine APPROVE!", "review: fine approve"]) {
    const parsed = verdictOf(comment(body));
    assert.ok(parsed, `'${body}' did not parse`);
    assert.equal(parsed.verdict, "APPROVE");
  }
});

test("A COMMENT THAT IS NOT A REVIEW IS NOT ONE, whatever it ends with", () => {
  // The failure that matters: ordinary prose being read as a verdict. Every one of
  // these is a comment somebody would plausibly write on a pull request.
  for (const body of [
    "this looks fine, I'd APPROVE",
    "APPROVE",
    "did anyone REVIEW this?",
    "",
    "   ",
    "Reviewing now, will come back with CHANGES or an approval",
  ]) {
    assert.equal(verdictOf(comment(body)), null, `'${body}' was read as a review`);
  }
});

test("a review that opens correctly and ends on nothing is NOT a verdict", () => {
  // A reviewer who did not finish. Inventing a verdict here is the one thing this
  // parser must never do.
  for (const body of ["REVIEW:", "REVIEW: I started looking at this and ran out of time", "REVIEW: LGTM", "REVIEW: 42"]) {
    assert.equal(verdictOf(comment(body)), null, `'${body}' was read as a verdict`);
  }
});

test("THE NEWEST REVIEW WINS, because a reviewer is allowed to change its mind", () => {
  const comments = [
    comment("REVIEW: the error path is wrong. CHANGES", "2026-09-12T09:00:00Z"),
    comment("REVIEW: fixed, thanks. APPROVE", "2026-09-12T11:00:00Z"),
  ];
  assert.equal(decidingReview(comments)?.verdict, "APPROVE");
  // And the other order gives the other answer, so this is ordering rather than luck.
  assert.equal(decidingReview([...comments].reverse())?.verdict, "APPROVE");
});

test("ordering is by timestamp, not by the order GitHub happened to return", () => {
  const older = comment("REVIEW: no. BLOCK", "2026-09-12T08:00:00Z");
  const newer = comment("REVIEW: yes. APPROVE", "2026-09-12T12:00:00Z");
  assert.equal(decidingReview([newer, older])?.verdict, "APPROVE");
  assert.equal(decidingReview([older, newer])?.verdict, "APPROVE");
});

test("non-review comments are ignored entirely, however many there are", () => {
  const comments = [
    comment("nice work"),
    comment("REVIEW: one thing to fix. CHANGES", "2026-09-12T10:00:00Z"),
    comment("agreed, I'd APPROVE too"),
    comment("bumping this"),
  ];
  assert.equal(decidingReview(comments)?.verdict, "CHANGES");
});

test("no comments at all is no review, not a default verdict", () => {
  assert.equal(decidingReview([]), null);
  assert.equal(decidingReview([comment("just a note"), at("2026-09-12T10:00:00Z")]), null);
});

test("a review with an unparseable timestamp still counts, but never outranks a real one", () => {
  const broken = comment("REVIEW: no. BLOCK", "not a date");
  assert.equal(decidingReview([broken])?.verdict, "BLOCK", "a bad timestamp must not discard the review");
  assert.equal(decidingReview([broken, comment("REVIEW: yes. APPROVE", "2026-09-12T10:00:00Z")])?.verdict, "APPROVE");
});

// ---- what each verdict does -------------------------------------------------------

test("no review means WAITING, and the reason says what to write", () => {
  const outcome = outcomeOf(null);
  assert.equal(outcome.kind, "waiting");
  assert.match(outcome.reason, /REVIEW:/);
  assert.match(outcome.reason, /APPROVE, CHANGES, BLOCK/, "a driver told only that it is waiting cannot tell the reviewer what to write");
});

test("APPROVE proceeds, CHANGES reworks, BLOCK halts", () => {
  const of = (verdict: string) => outcomeOf({ verdict: verdict as never, by: "reviewer", at: "2026-09-12T10:00:00Z", said: "because" });
  assert.equal(of("APPROVE").kind, "proceed");
  assert.equal(of("CHANGES").kind, "rework");
  assert.equal(of("BLOCK").kind, "halt");
});

test("DERIVED: every verdict maps to an outcome, so none of them falls through", () => {
  for (const verdict of VERDICTS) {
    const outcome = outcomeOf({ verdict, by: "r", at: "2026-09-12T10:00:00Z", said: "" });
    assert.notEqual(outcome.kind, "waiting", `${verdict} fell through to waiting, which would strand the job`);
  }
});

// ---- the pull request a job finished with ------------------------------------------

test("a pull request URL is recognised, with its owner, repo and number", () => {
  assert.deepEqual(pullRequestFrom("https://github.com/DrDustinEdwards/capsid-mcp/pull/27"), {
    owner: "DrDustinEdwards",
    repo: "capsid-mcp",
    number: 27,
  });
  assert.deepEqual(pullRequestFrom("https://github.com/DrDustinEdwards/capsid-mcp/pull/27/files"), {
    owner: "DrDustinEdwards",
    repo: "capsid-mcp",
    number: 27,
  });
});

test("anything that is not a pull request URL is null, so a document key does not become one", () => {
  // A job can finish with a document key. A review gate has nothing to read then, and
  // a parser that coerced one into a pull request number would go asking GitHub about
  // a number it made up.
  for (const ref of [null, undefined, "", "capsid/decisions.md", "https://github.com/DrDustinEdwards/capsid-mcp/issues/27", "https://example.com/pull/1"]) {
    assert.equal(pullRequestFrom(ref), null, `'${ref}' was read as a pull request`);
  }
});

// ---- reading the comments off GitHub ----------------------------------------------

test("readReviewComments asks the ISSUE comments endpoint, which is where the reviewer writes", async () => {
  // The reviewer agent posts through manage_pr action 'comment', which is an issue
  // comment. Reading a different endpoint from the one the reviewer writes to is how
  // a gate waits forever on a review that was posted.
  let asked = "";
  const env = fakeEnv({ APP_KV: fakeKv({ seedToken: true }).kv, GITHUB_APP_CLIENT_ID: "x", GITHUB_APP_PRIVATE_KEY: "x" });
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked = String(url);
    return new Response(
      JSON.stringify([{ user: { login: "reviewer" }, body: "REVIEW: fine. APPROVE", created_at: "2026-09-12T10:00:00Z" }]),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as never;
  try {
    const comments = await readReviewComments(env, "capsid", { owner: "DrDustinEdwards", repo: "capsid-mcp", number: 27 });
    assert.match(asked, /\/repos\/DrDustinEdwards\/capsid-mcp\/issues\/27\/comments/);
    assert.deepEqual(comments, [{ user: "reviewer", body: "REVIEW: fine. APPROVE", created_at: "2026-09-12T10:00:00Z" }]);
    assert.equal(decidingReview(comments)?.verdict, "APPROVE");
  } finally {
    globalThis.fetch = original;
  }
});

test("a comment with no author or no body does not crash the parser", async () => {
  // GitHub omits `user` on a comment from a deleted account. A gate that threw there
  // would hold every job on that pull request forever.
  const env = fakeEnv({ APP_KV: fakeKv({ seedToken: true }).kv, GITHUB_APP_CLIENT_ID: "x", GITHUB_APP_PRIVATE_KEY: "x" });
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{}, { user: {}, body: null }]), { status: 200, headers: { "Content-Type": "application/json" } })) as never;
  try {
    const comments = await readReviewComments(env, "capsid", { owner: "o", repo: "r", number: 1 });
    assert.deepEqual(comments, [
      { user: "(unknown)", body: "", created_at: "" },
      { user: "(unknown)", body: "", created_at: "" },
    ]);
    assert.equal(decidingReview(comments), null);
  } finally {
    globalThis.fetch = original;
  }
});
