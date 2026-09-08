import { anchorKey } from "../src/improve-schema.ts";

// THE SEED SCORES DOCUMENT, in test/ because nothing in the Worker calls it.
//
// It lived in src/improve-scores.ts and shipped in the bundle purely so tests
// could import it. What it IS, though, is the canonical statement of what a scores
// document declares: every live one was generated from it, and
// test/null-metrics.test.ts derives its Secondary list from the scorer's
// REPORTED_SECONDARY and fails in both directions. That derivation is the reason
// this is one function rather than five fixtures.
//
// ONLY WIRED METRICS APPEAR HERE. The seed used to declare error_count and
// p95_latency_ms for every namespace and two more stubs for foxhound, and nothing
// ever reported any of them: a document that lists five signals and behaves as
// three. The intentions live in capsid/improve/TASK-wire-the-metrics.md, where a
// reader can tell they are unbuilt. The `stub` marker survives in the parser for a
// metric that is genuinely half-wired; it is not a place to park a wish.
export function seedScoresDoc(namespace: string): string {
  return [
    `# improve scores - ${namespace}`,
    "",
    "What the improve loop measures here, and what it may never break. Written by a",
    "human, read by the Worker, never edited by the loop.",
    "",
    "## Anchors",
    "",
    "The floor. The loop may not edit this section and may not regress these values.",
    "Its sha256 is pinned in KV " + anchorKey(namespace) + " and checked before every",
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
    "- bundle_size_bytes: minimize weight 1",
    "",
  ].join("\n");
}
