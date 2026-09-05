// The scores document, the anchor checksum, and the keep-or-revert arithmetic.
//
// This module is the referee. Everything it decides is decided from a document a
// human wrote and a checksum a human pinned, and none of it calls a model. That
// separation is the point: a loop that can edit its own scoring function is not
// optimising, it is negotiating.
//
// THE DOCUMENT IS THE INTERFACE. improve/scores.md in each namespace has two
// sections and they are governed differently:
//
//   ## Anchors    the loop may never edit these and may never regress them.
//                 Checksummed. sha256 pinned in KV improve:anchor:<namespace>.
//                 Verified before every run; a mismatch REFUSES the run.
//   ## Secondary  what the loop optimises. A human may add or reweight a metric
//                 here freely, and doing so does NOT break the anchor pin.
//
// WHY THE CHECKSUM COVERS THE ANCHOR SECTION AND NOT THE WHOLE FILE, which is
// the one design decision in here worth arguing with. Covering the file would
// mean every legitimate human edit to a secondary weight breaks every run until
// the pin is refreshed by hand, and the failure would be a refusal at 03:00 that
// nobody sees until morning. Covering the anchor block gives the property that
// actually matters, which is that the loop cannot move its own floor, and leaves
// the tuning surface tunable. The arc asked for "the anchor doc is checksummed";
// this is that, scoped to the part the guarantee is about.

import { sha256Hex } from "./auth";

// ---- the shapes -------------------------------------------------------------

export type Direction = "maximize" | "minimize";

export interface AnchorSpec {
  metric: string;
  // "required" means the value must be truthy (1). A bound means the value must
  // be at least (min) or at most (max) the number.
  kind: "required" | "min" | "max";
  bound: number | null;
}

export interface SecondarySpec {
  metric: string;
  direction: Direction;
  weight: number;
  // A stub is parsed, listed and reported, and EXCLUDED from every comparison
  // until a human removes the marker. It exists so a namespace can declare a
  // metric it intends to wire without that metric silently scoring as zero.
  stub: boolean;
}

export interface ScoresDoc {
  namespace: string;
  anchors: AnchorSpec[];
  secondary: SecondarySpec[];
  // The exact bytes the checksum is taken over, after line-ending normalization.
  anchorBlock: string;
  // Parse complaints. A document with problems is still returned, because the
  // caller needs to report WHAT is wrong, not just that something is.
  problems: string[];
}

export type MetricMap = Record<string, number | null>;

// ---- parsing ----------------------------------------------------------------

const ANCHOR_HEADING = /^##\s+anchors\s*$/i;
const SECONDARY_HEADING = /^##\s+secondary\s*$/i;
const SECTION_HEADING = /^##\s+/;

// CRLF IS NORMALIZED BEFORE ANYTHING ELSE, including before the hash.
//
// This is not tidiness. capsid/repo-structure.md records the CRLF checkout hazard
// as a measured trap that has already produced two vacuous plants in this
// portfolio, and a scores document reaching the Worker through a repo checkout on
// an autocrlf host would hash differently from the same document written through
// the MCP write path. The pin would then mismatch for a reason that has nothing
// to do with anyone editing an anchor, and the run would refuse forever.
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sectionSlice(lines: string[], startIndex: number): string {
  const out: string[] = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (SECTION_HEADING.test(lines[i])) break;
    out.push(lines[i]);
  }
  // Trailing blank lines are dropped so a stray newline at the end of a section
  // cannot move the hash. Interior blank lines are kept: they are content.
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

// `- metric: required` | `- metric: min 0.95` | `- metric: max 3`
const ANCHOR_LINE = /^-\s*([a-z0-9_]+)\s*:\s*(required|min|max)(?:\s+(-?[0-9]*\.?[0-9]+))?\s*$/i;
// `- metric: maximize weight 3` | `- metric: minimize weight 1 stub`
const SECONDARY_LINE = /^-\s*([a-z0-9_]+)\s*:\s*(maximize|minimize)\s+weight\s+(-?[0-9]*\.?[0-9]+)(\s+stub)?\s*$/i;

export function parseScoresDoc(namespace: string, body: string): ScoresDoc {
  const lines = normalize(body).split("\n");
  const problems: string[] = [];
  const anchors: AnchorSpec[] = [];
  const secondary: SecondarySpec[] = [];

  const anchorAt = lines.findIndex((l) => ANCHOR_HEADING.test(l.trim()));
  const secondaryAt = lines.findIndex((l) => SECONDARY_HEADING.test(l.trim()));

  if (anchorAt === -1) problems.push("no '## Anchors' section: the loop has no floor and cannot run");
  if (secondaryAt === -1) problems.push("no '## Secondary' section: the loop has nothing to optimise");

  const anchorBlock = anchorAt === -1 ? "" : sectionSlice(lines, anchorAt);

  if (anchorAt !== -1) {
    for (const raw of anchorBlock.split("\n").slice(1)) {
      const line = raw.trim();
      if (!line.startsWith("-")) continue;
      const m = ANCHOR_LINE.exec(line);
      if (!m) {
        problems.push(`anchor line not understood: ${line}`);
        continue;
      }
      const kind = m[2].toLowerCase() as AnchorSpec["kind"];
      if (kind !== "required" && m[3] === undefined) {
        problems.push(`anchor '${m[1]}' declares ${kind} with no bound`);
        continue;
      }
      anchors.push({ metric: m[1], kind, bound: m[3] === undefined ? null : Number(m[3]) });
    }
  }

  if (secondaryAt !== -1) {
    for (const raw of sectionSlice(lines, secondaryAt).split("\n").slice(1)) {
      const line = raw.trim();
      if (!line.startsWith("-")) continue;
      const m = SECONDARY_LINE.exec(line);
      if (!m) {
        problems.push(`secondary line not understood: ${line}`);
        continue;
      }
      secondary.push({
        metric: m[1],
        direction: m[2].toLowerCase() as Direction,
        weight: Number(m[3]),
        stub: Boolean(m[4]),
      });
    }
  }

  if (anchorAt !== -1 && anchors.length === 0) {
    problems.push("the Anchors section declares no anchors; a loop with no floor is refused");
  }

  return { namespace, anchors, secondary, anchorBlock, problems };
}

// ---- the checksum -----------------------------------------------------------

export async function anchorChecksum(doc: ScoresDoc): Promise<string> {
  return sha256Hex(doc.anchorBlock);
}

export interface AnchorVerification {
  ok: boolean;
  // The refusal, in full, or null. Written as a sentence because it is what lands
  // in the task doc a human reads in the morning.
  refusal: string | null;
  current: string;
  pinned: string | null;
}

// FAIL CLOSED IN BOTH DIRECTIONS, which is the whole reason this is a function
// and not two lines at the call site.
//
// A missing pin is a refusal, not a free pass. The tempting alternative is
// "pin it on first sight", and that is exactly how an attacker or an accident
// installs its own floor: whatever the anchors happen to say the first time the
// loop looks becomes canon, and the pin then faithfully protects the wrong thing.
// A namespace joins the loop when a human pins its anchors, and never before.
export async function verifyAnchors(
  kv: KVNamespace,
  namespace: string,
  doc: ScoresDoc
): Promise<AnchorVerification> {
  const current = await anchorChecksum(doc);
  let pinned: string | null = null;
  try {
    pinned = await kv.get(`improve:anchor:${namespace}`);
  } catch (err) {
    return {
      ok: false,
      refusal: `could not read the anchor pin for ${namespace}: ${err instanceof Error ? err.message : String(err)}. Refusing the run rather than proceeding unpinned.`,
      current,
      pinned: null,
    };
  }
  if (doc.problems.length > 0) {
    return {
      ok: false,
      refusal: `${namespace}/improve/scores.md does not parse: ${doc.problems.join("; ")}`,
      current,
      pinned,
    };
  }
  if (!pinned) {
    return {
      ok: false,
      refusal:
        `no anchor pin for ${namespace}. A namespace joins the loop when a human pins its anchor block, never by the loop pinning what it happens to find. ` +
        `Set KV improve:anchor:${namespace} to ${current} once the Anchors section of ${namespace}/improve/scores.md reads the way you want it to.`,
      current,
      pinned: null,
    };
  }
  if (pinned.trim().toLowerCase() !== current) {
    return {
      ok: false,
      refusal:
        `anchor checksum mismatch for ${namespace}. Pinned ${pinned.trim().toLowerCase()}, the Anchors section now hashes to ${current}. ` +
        `Nothing ran. Either the anchors were edited on purpose, in which case re-pin, or they were edited by something that should not be editing them.`,
      current,
      pinned,
    };
  }
  return { ok: true, refusal: null, current, pinned };
}

// ---- the anchor verdict -----------------------------------------------------

export interface AnchorVerdict {
  passed: boolean;
  reasons: string[];
}

// AN UNMEASURED ANCHOR IS A FAILED ANCHOR. A null here means CI did not report
// the metric, and the arc's ruling is explicit: any missing or unauthenticated
// score is treated as a revert. The alternative, skipping an anchor that was not
// reported, means a scorer that quietly stops running the holdout suite scores
// exactly like one that runs it and passes.
export function anchorVerdict(anchors: AnchorSpec[], values: MetricMap): AnchorVerdict {
  const reasons: string[] = [];
  for (const spec of anchors) {
    const value = values[spec.metric];
    if (value === undefined || value === null) {
      reasons.push(`anchor ${spec.metric} was not reported`);
      continue;
    }
    if (spec.kind === "required" && !(value > 0)) {
      reasons.push(`anchor ${spec.metric} is required and reported ${value}`);
    } else if (spec.kind === "min" && spec.bound !== null && value < spec.bound) {
      reasons.push(`anchor ${spec.metric} reported ${value}, below its floor of ${spec.bound}`);
    } else if (spec.kind === "max" && spec.bound !== null && value > spec.bound) {
      reasons.push(`anchor ${spec.metric} reported ${value}, above its ceiling of ${spec.bound}`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

// A separate question from the verdict above: did any anchor get WORSE than the
// base, even while still inside its bound. The drift gate pauses a namespace on
// this, because an anchor sliding within tolerance is the shape of a slow
// regression that no single attempt is ever refused for.
export function anchorRegressions(anchors: AnchorSpec[], before: MetricMap, after: MetricMap): string[] {
  const out: string[] = [];
  for (const spec of anchors) {
    const a = before[spec.metric];
    const b = after[spec.metric];
    if (a === undefined || a === null || b === undefined || b === null) continue;
    // Every anchor is "higher is better": required is 0 or 1, a min is a floor,
    // and a max is a ceiling on something already inverted by whoever wrote it.
    if (spec.kind === "max" ? b > a : b < a) {
      out.push(`${spec.metric} moved from ${a} to ${b}`);
    }
  }
  return out;
}

// ---- the secondary score ----------------------------------------------------

export interface MetricDelta {
  metric: string;
  direction: Direction;
  weight: number;
  before: number | null;
  after: number | null;
  // null when the metric could not be compared, with `why` saying so.
  contribution: number | null;
  why?: string;
}

export interface Comparison {
  improved: boolean;
  delta: number;
  scoreBefore: number;
  scoreAfter: number;
  // How many metrics actually had a value on BOTH sides. Zero means the
  // comparison proved nothing, and `improved` is false in that case.
  compared: number;
  details: MetricDelta[];
  reason: string;
}

// Relative improvement, clamped, so one metric measured in bytes cannot drown
// four measured in counts.
//
// The denominator is max(|before|, 1) rather than |before|, which handles the
// two cases a plain ratio does not: a base of zero (0 lint errors, and any
// increase should register as a loss rather than as a division by zero) and a
// base near zero (1 error becoming 2 is a real doubling and should not score as
// an infinite one). Clamped to [-1, 1] so a single metric's contribution is
// bounded by its weight.
function relative(direction: Direction, before: number, after: number): number {
  const scale = Math.max(Math.abs(before), 1);
  const raw = direction === "maximize" ? (after - before) / scale : (before - after) / scale;
  return Math.max(-1, Math.min(1, raw));
}

// KEEP OR REVERT, and the default is revert.
//
// An attempt is kept when the anchors hold and the weighted secondary score is
// strictly better. Strictly, not "no worse": a change that moves nothing is
// churn, and churn accumulates into a diff nobody can review. A tie reverts.
//
// AN UNPROVABLE COMPARISON REVERTS. If every secondary metric is a stub, or CI
// reported none of them, `compared` is 0 and the attempt is reverted with that
// as its reason. This is the case the whole module is written to get right: the
// cheapest way to score well is to report nothing, and a system that reads
// silence as success rewards exactly that.
export function compare(specs: SecondarySpec[], before: MetricMap, after: MetricMap): Comparison {
  const details: MetricDelta[] = [];
  let delta = 0;
  let scoreBefore = 0;
  let scoreAfter = 0;
  let compared = 0;

  for (const spec of specs) {
    const a = before[spec.metric] ?? null;
    const b = after[spec.metric] ?? null;
    if (spec.stub) {
      details.push({ ...spec, before: a, after: b, contribution: null, why: "declared a stub, excluded until wired" });
      continue;
    }
    if (a === null || b === null) {
      details.push({
        ...spec,
        before: a,
        after: b,
        contribution: null,
        why: a === null && b === null ? "not reported on either side" : a === null ? "no baseline" : "not reported by this attempt",
      });
      continue;
    }
    const contribution = spec.weight * relative(spec.direction, a, b);
    compared += 1;
    delta += contribution;
    // The absolute scores exist for the improve_attempts columns and for the
    // status tool. They are the weighted values themselves, sign-corrected so
    // higher is better on both, which makes score_before and score_after
    // comparable rows in a table a human reads.
    const sign = spec.direction === "maximize" ? 1 : -1;
    scoreBefore += spec.weight * sign * a;
    scoreAfter += spec.weight * sign * b;
    details.push({ ...spec, before: a, after: b, contribution });
  }

  if (compared === 0) {
    return {
      improved: false,
      delta: 0,
      scoreBefore,
      scoreAfter,
      compared,
      details,
      reason:
        "no secondary metric could be compared: every one was a stub or was missing on one side. " +
        "An attempt that proves nothing is reverted, because reporting nothing must never be the cheapest way to score well.",
    };
  }

  const improved = delta > 0;
  return {
    improved,
    delta,
    scoreBefore,
    scoreAfter,
    compared,
    details,
    reason: improved
      ? `secondary score improved by ${delta.toFixed(4)} across ${compared} comparable metric(s)`
      : `secondary score moved ${delta.toFixed(4)} across ${compared} comparable metric(s); a tie or a loss reverts`,
  };
}

// ---- the seed document ------------------------------------------------------

// THE FIRST-PASS METRICS, per the arc. capsid, foxing, germomics and
// dustinedwards take tests, lint, errors and latency. foxhound adds the two stubs
// (recovery_rate for the legacy Recova product, dispute_win_rate for foxhound
// itself; the namespace maps to both repos, see the roster note in
// improve-schema.ts).
//
// Generated rather than hand-written per namespace so five documents cannot drift
// into five formats, and so the parser above is exercised against the exact text
// this function emits (test/improve-scores.test.ts round-trips it).
export function seedScoresDoc(namespace: string): string {
  const stubs =
    namespace === "foxhound"
      ? [
          "- recovery_rate: maximize weight 0 stub",
          "- dispute_win_rate: maximize weight 0 stub",
        ]
      : [];
  return [
    `# improve scores - ${namespace}`,
    "",
    "What the improve loop measures here, and what it may never break. Written by a",
    "human, read by the Worker, never edited by the loop.",
    "",
    "## Anchors",
    "",
    "The floor. The loop may not edit this section and may not regress these values.",
    "Its sha256 is pinned in KV improve:anchor:" + namespace + " and checked before every",
    "run; a mismatch refuses the run and writes a task doc. An anchor CI did not",
    "report counts as failed, never as skipped.",
    "",
    "- build_passes: required",
    "- holdout_pass_rate: min 1.0",
    "",
    "## Secondary",
    "",
    "What the loop optimises. Edit these freely: this section is not checksummed, so",
    "adding or reweighting a metric here does not break the anchor pin. A line marked",
    "`stub` is parsed and reported and excluded from scoring until the marker is",
    "removed, so declaring an intention never scores as a zero.",
    "",
    "- test_pass_rate: maximize weight 3",
    "- lint_count: minimize weight 2",
    "- error_count: minimize weight 2",
    "- p95_latency_ms: minimize weight 1",
    "- bundle_size_bytes: minimize weight 1",
    ...stubs,
    "",
  ].join("\n");
}
