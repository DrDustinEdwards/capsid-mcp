// ---- reading a reviewer's verdict off a pull request -----------------------------
//
// GROUP 4 OF THE ROLES ARC. A job posted with review_required does not reach the seat
// until a reviewer has said something about its pull request.
//
// WHY A COMMENT RATHER THAN A GITHUB REVIEW. The reviewer agent holds can_comment_pr
// and nothing else, so a comment is the only mark it can leave. Reading the thing the
// credential can actually write is what keeps the credential narrow: accepting a
// GitHub "approve" would mean handing the reviewer a scope that can also request
// changes on, dismiss and block other people's reviews.
//
// THE ENVELOPE IS DELIBERATELY STRICT. `REVIEW:` at the start and one of three words
// at the end. A verdict parsed out of free prose would be a parser guessing at intent
// on the one decision in this system that is allowed to send work back, and the
// failure would look like a review that happened.

import type { Env } from "./env";
import { ghFetch } from "./github/client";

export const REVIEW_PREFIX = "REVIEW:";

export const VERDICTS = ["APPROVE", "CHANGES", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewComment {
  // The comment author's login, as GitHub reports it. Used only to say WHO reviewed
  // in the audit row; it is not what authorizes the review, because a comment anybody
  // can write is not a credential. The narrowing that matters happened at the scope.
  user: string;
  body: string;
  created_at: string;
}

export interface Review {
  verdict: Verdict;
  by: string;
  at: string;
  // The comment with its envelope stripped, so an audit row and a driver both read
  // what the reviewer actually said rather than the machine-readable wrapper.
  said: string;
}

/** The verdict a single comment carries, or null when it is not a review at all.
 *
 *  Both ends are required. A comment that opens with REVIEW: and trails off is a
 *  reviewer who did not finish, and treating that as any verdict would be inventing
 *  one; a comment that ends in APPROVE without the prefix is ordinary prose that
 *  happens to end in a word. */
export function verdictOf(comment: ReviewComment): Review | null {
  const body = comment.body?.trim() ?? "";
  if (!body.toUpperCase().startsWith(REVIEW_PREFIX)) return null;
  const rest = body.slice(REVIEW_PREFIX.length).trim();
  // The LAST word, with trailing punctuation and formatting allowed, because a
  // reviewer writing "... CHANGES." or "**BLOCK**" means the verdict it looks like.
  const tail = rest.replace(/[\s*_`.!]+$/u, "");
  const match = /([A-Za-z]+)$/u.exec(tail);
  if (!match) return null;
  const word = match[1].toUpperCase();
  if (!(VERDICTS as readonly string[]).includes(word)) return null;
  return {
    verdict: word as Verdict,
    by: comment.user,
    at: comment.created_at,
    said: tail.slice(0, tail.length - match[1].length).replace(/[\s*_`,:-]+$/u, "").trim(),
  };
}

/** The review that decides, out of every comment on a pull request.
 *
 *  THE NEWEST ONE WINS, and that is the whole rule. A reviewer that said CHANGES,
 *  watched the driver fix it and then said APPROVE has changed its mind, and a rule
 *  that took the first verdict would hold the job against a review that no longer
 *  describes the code. Ordered by created_at rather than by array position, because
 *  the caller's ordering is GitHub's and is not promised. */
export function decidingReview(comments: readonly ReviewComment[]): Review | null {
  let best: Review | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const comment of comments) {
    const review = verdictOf(comment);
    if (!review) continue;
    const at = Date.parse(review.at);
    // An unparseable timestamp does not get to win by accident. It still counts as a
    // review, but only when nothing else does.
    const rank = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
    if (best === null || rank >= bestAt) {
      best = review;
      bestAt = rank;
    }
  }
  return best;
}

// ---- what a verdict does ----------------------------------------------------------

export type ReviewOutcome =
  // Nothing has reviewed it yet. The driver waits; the job stays exactly where it is.
  | { kind: "waiting"; reason: string }
  // The seat may have it, which is what would have happened with no reviewer at all.
  | { kind: "proceed"; review: Review }
  // Back to the driver, and it costs a correction.
  | { kind: "rework"; review: Review }
  // Stopped for the seat, with the reviewer's objection as the reason.
  | { kind: "halt"; review: Review };

/** What a job with review_required does when its driver tries to hand it on.
 *
 *  Pure, so every branch is driven in a test without GitHub. The mapping is one line
 *  each and is stated here rather than at the call site so the queue and the docs
 *  cannot describe different rules. */
export function outcomeOf(review: Review | null): ReviewOutcome {
  if (!review) {
    return {
      kind: "waiting",
      reason:
        `no review yet. This job was posted with review_required, so it waits for a comment on its pull request ` +
        `starting with '${REVIEW_PREFIX}' and ending with ${VERDICTS.join(", ")}.`,
    };
  }
  switch (review.verdict) {
    case "APPROVE":
      return { kind: "proceed", review };
    case "CHANGES":
      return { kind: "rework", review };
    case "BLOCK":
      return { kind: "halt", review };
  }
}

// The pull request a reference names, or null when it names something else. A job can
// finish with a document key rather than a pull request, and a review gate has nothing
// to read in that case: coercing one into a number would send the Worker to GitHub
// asking about a pull request it invented.
//
// ANCHORED AT BOTH ENDS. prUrlsFromJob in src/outcome-prs.ts scans free prose for
// every pull request a job mentioned, which is the right rule for counting evidence
// and the wrong one here: the review gate needs THE pull request this job's work is,
// and a URL mentioned in passing in a summary is not it.
const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function pullRequestFrom(ref: string | null | undefined): { owner: string; repo: string; number: number } | null {
  if (!ref) return null;
  const match = PR_URL.exec(ref.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

// ---- reading the comments ---------------------------------------------------------

/** Every comment on a pull request, as the review parser wants them.
 *
 *  Issue comments, not review comments: a pull request is an issue to GitHub, and the
 *  reviewer agent's manage_pr action `comment` posts here. Reading a different
 *  endpoint from the one the reviewer writes to is how a gate ends up waiting forever
 *  on a review that was posted. */
export async function readReviewComments(
  env: Env,
  namespace: string,
  pr: { owner: string; repo: string; number: number }
): Promise<ReviewComment[]> {
  const resp = await ghFetch(env, pr.owner, pr.repo, `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=100`);
  if (!resp.ok) throw new Error(`reading review comments failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const rows = (await resp.json()) as Array<{ user?: { login?: string }; body?: string; created_at?: string }>;
  return rows.map((r) => ({
    user: r.user?.login ?? "(unknown)",
    body: r.body ?? "",
    created_at: r.created_at ?? "",
  }));
}

/** The gate, end to end: what does the review say about this job's pull request.
 *
 *  A job with no pull request PROCEEDS. The review gate is about the code a pull
 *  request carries, and a job that finished with a document key has none; holding it
 *  for a review nobody can write would strand it forever. Said here rather than at
 *  the call site so both transitions that consult this cannot answer differently. */
export async function reviewGate(
  env: Env,
  job: { namespace: string; review_required: number; result_ref: string | null }
): Promise<ReviewOutcome | null> {
  if (!job.review_required) return null;
  const pr = pullRequestFrom(job.result_ref);
  if (!pr) return null;
  const comments = await readReviewComments(env, job.namespace, pr);
  return outcomeOf(decidingReview(comments));
}
