// Which commit the next attempt branches from.
//
// THE NAIVE ANSWER IS "the current best", AND IT IS WRONG IN A SPECIFIC WAY. Best
// is the highest scoring commit found so far. Branching from it every time turns
// the loop into hill climbing: it walks uphill from wherever it happens to be
// standing and never leaves the hill it started on. A change that scored slightly
// worse than best but opened up three later changes that each scored much better
// is, in hindsight, the better place to have stood.
//
// So a base is chosen on TWO signals: how well it scored, and how well its
// DESCENDANTS have done. The second is lineage potential, and it is the one the
// arc asked for. Everything below is a pure function over rows the caller already
// has, so the policy is testable without a database, a model, or a repo.

import type { BestRecord } from "./improve-schema";
import type { AttemptRow } from "./improve-state";

export interface BaseCandidate {
  // The commit to branch from.
  sha: string;
  // The attempt that produced it, or null for the best record's own commit,
  // which may predate any attempt.
  attemptId: string | null;
  score: number;
  descendants: number;
  wins: number;
  potential: number;
  weight: number;
}

export interface BaseChoice {
  sha: string;
  attemptId: string | null;
  // Why this one, in a sentence, because it lands in the attempt's archive
  // document and a human reading that document a month later needs to know
  // whether the loop was exploring or exploiting.
  why: string;
  candidates: BaseCandidate[];
}

// LAPLACE SMOOTHING, and it is doing real work rather than avoiding a divide by
// zero. Without it a base with one kept descendant has a potential of 1.0 and
// outranks a base with nine kept out of ten, on one sample. With it those become
// 0.67 and 0.83, which is the ordering a human would pick. It also gives a base
// with NO descendants a defined value of 0.5, so an unexplored branch is treated
// as genuinely unknown rather than as known-bad.
function potentialOf(wins: number, total: number): number {
  return (wins + 1) / (total + 2);
}

// Every attempt descended from `rootId`, following lineage_parent upward. Walks
// the parent chain per attempt rather than building a tree, because the sets are
// small (at most ten attempts per run) and a walk cannot produce a cycle-induced
// hang without the visited guard catching it first.
function descendantsOf(attempts: AttemptRow[], rootId: string): AttemptRow[] {
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const out: AttemptRow[] = [];
  for (const attempt of attempts) {
    if (attempt.id === rootId) continue;
    const seen = new Set<string>([attempt.id]);
    let cursor = attempt.lineage_parent;
    while (cursor && !seen.has(cursor)) {
      if (cursor === rootId) {
        out.push(attempt);
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.lineage_parent ?? null;
    }
  }
  return out;
}

// SCORE AND POTENTIAL ARE COMBINED, NOT RANKED LEXICOGRAPHICALLY. Ranking by
// potential first would send every run down whichever branch happened to get
// lucky early; ranking by score first is the hill climbing this exists to avoid.
// The weights say: potential is worth about as much as a moderate score
// difference, which is the whole claim being made and the number to tune if the
// loop turns out to explore too much or too little.
const SCORE_WEIGHT = 1;
const POTENTIAL_WEIGHT = 2;

// Scores across namespaces and metrics are not on one scale, so the raw score is
// squashed into [0, 1] before it is combined with a probability. tanh rather than
// a min-max normalization over the candidate set: min-max makes the best
// candidate 1.0 and the worst 0.0 no matter how close together they are, which
// manufactures a difference out of noise on a run where every attempt scored
// about the same.
function squash(score: number): number {
  return (Math.tanh(score) + 1) / 2;
}

export function selectBase(best: BestRecord | null, attempts: AttemptRow[], defaultSha: string | null): BaseChoice {
  const candidates: BaseCandidate[] = [];

  // Candidate one: the recorded best. Its potential is measured over every
  // attempt that descends from the attempt that produced it, when there is one.
  if (best?.sha) {
    const descendants = best.attempt_id ? descendantsOf(attempts, best.attempt_id) : [];
    const wins = descendants.filter((a) => a.kept === 1).length;
    const potential = potentialOf(wins, descendants.length);
    candidates.push({
      sha: best.sha,
      attemptId: best.attempt_id,
      score: best.score,
      descendants: descendants.length,
      wins,
      potential,
      weight: SCORE_WEIGHT * squash(best.score) + POTENTIAL_WEIGHT * potential,
    });
  }

  // Candidates two onward: every KEPT attempt with a commit. A reverted attempt
  // is not a candidate: its change was undone, so its head sha describes a state
  // that was measured and rejected.
  for (const attempt of attempts) {
    if (attempt.kept !== 1 || !attempt.head_sha) continue;
    if (candidates.some((c) => c.sha === attempt.head_sha)) continue;
    const descendants = descendantsOf(attempts, attempt.id);
    const wins = descendants.filter((a) => a.kept === 1).length;
    const potential = potentialOf(wins, descendants.length);
    const score = attempt.score_after ?? 0;
    candidates.push({
      sha: attempt.head_sha,
      attemptId: attempt.id,
      score,
      descendants: descendants.length,
      wins,
      potential,
      weight: SCORE_WEIGHT * squash(score) + POTENTIAL_WEIGHT * potential,
    });
  }

  if (candidates.length === 0) {
    return {
      sha: defaultSha ?? "",
      attemptId: null,
      why: defaultSha
        ? "no best record and no kept attempts yet, so the run branches from the repo's default branch"
        : "no base could be resolved: there is no best record, no kept attempt, and no default branch sha",
      candidates,
    };
  }

  // Deterministic argmax. Ties break toward the LATER candidate, which is the
  // more recent commit, because a tie between an old base and a new one is a tie
  // the loop should resolve by moving forward.
  let chosen = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (candidate.weight >= chosen.weight) chosen = candidate;
  }

  const bestByScore = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  const why =
    chosen.sha === bestByScore.sha
      ? `branching from the highest scoring base (score ${chosen.score.toFixed(3)}, lineage potential ${chosen.potential.toFixed(2)} over ${chosen.descendants} descendant(s))`
      : `branching from a lower scoring base on lineage potential: score ${chosen.score.toFixed(3)} against the best ${bestByScore.score.toFixed(3)}, but ${chosen.wins} of ${chosen.descendants} descendants were kept (potential ${chosen.potential.toFixed(2)})`;

  return { sha: chosen.sha, attemptId: chosen.attemptId, why, candidates };
}
