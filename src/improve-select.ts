import type { BestRecord } from "./improve-schema";
import type { AttemptRow } from "./improve-state";

export interface BaseCandidate {
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
  why: string;
  candidates: BaseCandidate[];
}

// Laplace: (wins+1)/(total+2). A base with one kept descendant is 0.67, not 1.0;
// an unexplored base is 0.5, not known-bad.
function potentialOf(wins: number, total: number): number {
  return (wins + 1) / (total + 2);
}

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

const SCORE_WEIGHT = 1;
const POTENTIAL_WEIGHT = 2;

// tanh, not min-max over the candidate set: min-max manufactures a 1.0 vs 0.0
// gap out of noise when every attempt scored about the same.
function squash(score: number): number {
  return (Math.tanh(score) + 1) / 2;
}

export function selectBase(best: BestRecord | null, attempts: AttemptRow[], defaultSha: string | null): BaseChoice {
  const candidates: BaseCandidate[] = [];

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

  // Reverted attempts are not candidates: their head sha was measured and rejected.
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

  // Ties break toward the later candidate (more recent commit).
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
