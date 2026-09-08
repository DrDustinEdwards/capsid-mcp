
// THE SEED SCORES DOCUMENT, re-exported from src.
//
// It was moved here on 2026-09-07 as an export with no caller in src/ or test/,
// and moved back the next day: the HOLDOUT suite imports it from src, and the
// holdout is structurally invisible to any scan that runs in this repo. 28/30
// without it, 30/30 with it, against an anchor of min 1.0.
//
// This file stays as the import site every test already uses, so the move and the
// move back cost the test suite nothing. One spelling, in src. What it IS, though, is the canonical statement of what a scores
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
export { seedScoresDoc } from "../src/improve-scores.ts";
