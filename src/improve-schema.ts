// The improve loop's vocabulary: the roster, the states, the keys and the paths.
//
// A leaf, deliberately. Everything else in the improve family imports this and
// nothing here imports any of them, so the names a run is made of can be read
// without opening the orchestrator. Same reasoning that moved Env out of
// server.ts in the 2026-08-17 quality audit.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a string two modules must agree on is
// declared here once. The report-prefix class of bug (intake writing under one
// prefix and the prune reading another) is what it prevents, and
// test/source-conventions.test.ts already guards that class for REPORT_PREFIX.

// ---- the roster -------------------------------------------------------------

// WHICH NAMESPACES THE LOOP TOUCHES, and it is a closed list rather than "every
// registered namespace". A namespace joins by being added here AND by having a
// scores document with a pinned anchor checksum. Nothing opts in by existing.
//
// THE foxhound QUESTION, RESOLVED 2026-09-05 by renaming the namespace.
//
// The arc named six projects: capsid, foxing, germomics, dustinedwards, recova
// and foxhound. foxhound was NOT a namespace then: it was the primary repo of the
// `recova` namespace, so the roster was keyed by `recova` and carried a note
// explaining the mismatch. Dustin ruled the namespace itself be renamed
// `recova` to `foxhound` before the loop was ever switched on, which removes the
// mismatch rather than documenting it.
//
// The namespace still maps to THREE repos (foxhound primary, recova legacy,
// recova-mcp legacy-mcp), so `foxhound` here means the namespace and the loop
// targets its PRIMARY repo. Legacy recova is hotfix-only until the Phase 9
// cutover and is reached only by an explicit `repo` selector, which the loop
// never passes.
//
// foxhound carries BOTH stub metrics: recovery_rate for the legacy product and
// dispute_win_rate for foxhound itself. Both return null, so neither moves a
// score until Dustin wires it.
export const ROSTER = ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"] as const;

export type RosterNamespace = (typeof ROSTER)[number];

export function onRoster(namespace: string): namespace is RosterNamespace {
  return (ROSTER as readonly string[]).includes(namespace);
}

// ---- modes ------------------------------------------------------------------

export const IMPROVE_MODES = ["api", "subscription", "off"] as const;
export type ImproveMode = (typeof IMPROVE_MODES)[number];

// THE DEFAULT IS "off", in the strong sense: an unset key, an unreadable KV, or a
// value nobody recognises all resolve to off. A loop that starts writing to five
// repos because a KV read returned an unexpected string is the failure this
// default exists to make impossible.
export const DEFAULT_MODE: ImproveMode = "off";

// ---- KV keys ----------------------------------------------------------------

// Every improve key the Worker reads or writes, built by a function so no caller
// can typo a prefix into a keyspace nothing reaps.
export const MODE_KEY = "improve_mode";
export const bestKey = (namespace: string) => `improve:best:${namespace}`;
export const pausedKey = (namespace: string) => `improve:paused:${namespace}`;
export const anchorKey = (namespace: string) => `improve:anchor:${namespace}`;
// The meta-loop's weekly cadence marker. One key, not one per namespace: the
// meta-loop reasons across all of them at once.
export const META_LAST_KEY = "improve:meta:last";

// A best record is the commit a namespace is known good at, plus the scores that
// made it best. Both halves are needed: the sha says where to restore to, the
// snapshot says what a later run is compared against.
export interface BestRecord {
  sha: string;
  run_id: string;
  attempt_id: string | null;
  recorded_at: string;
  anchors: Record<string, number | null>;
  secondary: Record<string, number | null>;
  score: number;
}

// ---- R2 ---------------------------------------------------------------------

// The holdout prefix, in the HOLDOUT bucket and nowhere else. Declared here so the
// scorer and the guard test agree on one spelling. The BINDING is what is
// restricted, and only src/improve-scorer.ts holds it.
export const HOLDOUT_PREFIX = "improve/holdout/";
export const holdoutManifestKey = (namespace: string) => `${HOLDOUT_PREFIX}${namespace}/manifest.json`;

// What the manifest says about a namespace's hidden suite. The Worker never reads
// the TESTS: CI pulls those straight from R2 with its own read-only token. The
// Worker reads only the COUNT, and that is what makes a score report checkable.
// A report claiming 3 holdout tests passed when the manifest says 11 exist is
// refused, so "delete the failing holdout tests" is not a way to score well.
export interface HoldoutManifest {
  namespace: string;
  total: number;
  updated_at: string;
}

// ---- document paths ---------------------------------------------------------

export const SCORES_PATH = "improve/scores.md";
export const README_PATH = "improve/README.md";
export const RUN_PROMPT_PATH = "improve/prompts/run.md";
export const runTaskPath = (day: string) => `improve/run-${day}.md`;
export const archivePath = (runIdValue: string, attemptIdValue: string) =>
  `improve/archive/${runIdValue}/${attemptIdValue}.md`;
export const skillPath = (skillId: string) => `improve/skills/${skillId}.md`;
export const proposalPath = (kind: string, day: string) => `improve/proposals/${kind}-${day}.md`;

// THE META-LOOP'S ENTIRE WRITE SURFACE. It proposes; it never applies. Stated as
// a prefix rather than as a rule in prose because src/improve-meta.ts asserts
// against it and test/improve-meta.test.ts drives that assertion.
export const PROPOSAL_PREFIX = "improve/proposals/";

// ---- states -----------------------------------------------------------------

export const RUN_STATUSES = [
  "opening",
  "attempting",
  "awaiting-score",
  "judging",
  "finalizing",
  "done",
  "paused",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// A run in one of these is finished and no tick touches it again. The partial
// unique index in migrations/0003_improve.sql names the same two values, and
// test/improve-state.test.ts asserts the two agree: a terminal status added here
// and not there would let two active runs exist for one namespace.
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["done", "paused"];

// THE EXPERIMENTAL CONDITION a run was executed under, per the arc's ruling: the
// column exists so an ablation is a query rather than an archaeology exercise.
//
// A TEXT column with NO CHECK constraint, validated here instead, which is the
// same shape and the same reasoning as DOC_STATUSES in src/doc-meta.ts: the
// vocabulary is exactly this list, the database does not restate it, and
// test/improve-condition.test.ts derives the migration's documented set from this
// one so the two cannot drift.
//
// EACH VALUE HAS TO DO SOMETHING. A condition recorded on a run that changed
// nothing about how the run behaved is a label that lies, which is worse than no
// column. What each one switches off is enforced in src/improve-run.ts and
// asserted in that test.
export const RUN_CONDITIONS = ["full", "no-memory", "no-transfer"] as const;
export type RunCondition = (typeof RUN_CONDITIONS)[number];

export const DEFAULT_CONDITION: RunCondition = "full";

export function isRunCondition(value: string): value is RunCondition {
  return (RUN_CONDITIONS as readonly string[]).includes(value);
}

export const ATTEMPT_STATUSES = [
  "pending",
  "awaiting-score",
  "kept",
  "reverted",
  "flagged",
  "timed-out",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

// ---- the numbers ------------------------------------------------------------

// Per namespace per run. Here so the tool description, the task doc and the loop
// cannot quote three different figures.
export const MAX_ATTEMPTS_PER_RUN = 10;

// After this many reverts in a row the run restores to improve:best and stops.
// Consecutive rather than cumulative: a run alternating keep and revert is
// learning slowly, a run reverting five times running has lost the thread.
export const MAX_CONSECUTIVE_REVERTS = 5;

// How long a dispatched scorer workflow has to report back. Past it the attempt
// is reverted and logged and the run continues rather than wedging. Stated
// honestly: this is a ceiling chosen against a CI job that takes two to four
// minutes on this repo today, not a measured p99 of the five repos.
export const SCORE_TIMEOUT_MS = 20 * 60 * 1000;

// A run alive this long finalizes wherever it is. The nightly cadence is the
// reason: a run still crawling at hour seven would still hold the namespace's one
// active-run slot when the next night's opener fires.
export const RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// The drift gate. Over this share of reverts across the last three runs, or any
// anchor drop, and the namespace pauses.
export const DRIFT_REVERT_RATIO = 0.6;
export const DRIFT_RUN_WINDOW = 3;

// The meta-loop's cadence.
export const META_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// ---- model routing ----------------------------------------------------------

// Cheap models for reading, the mid tier for writing code, the top tier only
// where the reasoning is about the system rather than about one change. A map
// rather than three constants, so the routing can be asserted whole by a test and
// so a new stage cannot pick a model implicitly.
export type ModelStage = "triage" | "monitor" | "attempt" | "abstract" | "meta";

export const MODEL_FOR: Record<ModelStage, string> = {
  // Reading a diff and answering a bounded question about it. The bare alias,
  // not the dated snapshot: the dated form resolves too, and pinning it here
  // would make this file the one place a model upgrade has to be remembered.
  triage: "claude-haiku-4-5",
  monitor: "claude-haiku-4-5",
  // Writing the change.
  attempt: "claude-sonnet-5",
  // Cross-project reasoning: what does this change generalize to.
  abstract: "claude-opus-5",
  // Editing the run prompt itself.
  meta: "claude-opus-5",
};

// ---- protected paths --------------------------------------------------------

// WHAT AN ATTEMPT MAY NOT TOUCH, matched against every changed path in a diff.
//
// This is the deterministic half of the reward-hacking monitor and it runs in
// every mode, including when no model is available to run the other half. It is
// first because it is the half that cannot be talked out of a verdict: a diff
// that edits a test is reverted whether or not a model thinks the edit was
// reasonable, and the model's job is the cases a pattern cannot name.
//
// Matched by SHAPE rather than by the spellings that exist today, per
// capsid/conventions.md: the guard has to fire on the sixth repo's layout as well
// as on the five that exist now.
export const PROTECTED_PATH_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|\/)tests?\//i, why: "a test directory" },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/i, why: "a test file" },
  { pattern: /(^|\/)__tests__\//i, why: "a test directory" },
  { pattern: /(^|\/)\.github\//i, why: "CI configuration, including the scorer workflow" },
  { pattern: /(^|\/)improve\//i, why: "the improve loop's own documents" },
  { pattern: /(^|\/)src\/improve-/i, why: "the improve loop's own source" },
  { pattern: /(^|\/)migrations\//i, why: "a database migration" },
  { pattern: /(^|\/)wrangler\.jsonc?$/i, why: "deployment configuration" },
  { pattern: /(^|\/)package(-lock)?\.json$/i, why: "the dependency manifest or lockfile" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/i, why: "compiler configuration" },
  { pattern: /\.(config|conf)\.[cm]?[jt]s$/i, why: "a config file" },
  { pattern: /(^|\/)\.?eslint[^/]*$/i, why: "lint configuration" },
  { pattern: /(^|\/)\.claude\//i, why: "the agent steering layer" },
  { pattern: /(^|\/)CLAUDE\.md$/i, why: "the repo briefing" },
];

// Returns the reasons a change set is disqualified, or an empty array.
export function protectedHits(paths: string[]): Array<{ path: string; why: string }> {
  const hits: Array<{ path: string; why: string }> = [];
  for (const path of paths) {
    for (const { pattern, why } of PROTECTED_PATH_PATTERNS) {
      if (pattern.test(path)) {
        hits.push({ path, why });
        break;
      }
    }
  }
  return hits;
}

// ---- ids --------------------------------------------------------------------

// Run and attempt ids are readable on purpose: they become document paths
// (improve/archive/<run_id>/<attempt_id>.md), branch names and audit rows, and an
// opaque uuid in all three costs more than the characters it saves.
export function runId(namespace: string, now: Date): string {
  return `${namespace}-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

export function attemptId(runIdValue: string, index: number): string {
  return `${runIdValue}-a${String(index).padStart(2, "0")}`;
}

export function branchName(attemptIdValue: string): string {
  return `improve/${attemptIdValue}`;
}

// The America/Chicago day, which is what a run doc is dated by. Computed through
// Intl rather than by subtracting an offset, because the offset is 5 hours for
// part of the year and 6 for the rest, and a hardcoded one silently mislabels
// every document written in the other half.
export function chicagoDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// The America/Chicago hour, 0 to 23. The nightly opener fires on this rather than
// on a UTC cron hour: Cloudflare cron expressions are UTC only, so "03:00
// America/Chicago" is 08:00 UTC for part of the year and 09:00 for the rest. The
// cron covers both hours and this decides which one is really 03:00.
export function chicagoHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    hour12: false,
  }).format(now);
  // en-US with hour12 false renders midnight as "24" in some ICU versions and
  // "00" in others. Both mean hour zero; normalising here keeps the opener from
  // firing on a day boundary in one runtime and not in another.
  return Number(hour) % 24;
}
