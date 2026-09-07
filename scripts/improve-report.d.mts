// Types for the trusted scorer glue, so test/improve-report.test.ts and
// test/scorer-isolation.test.ts type-check under tsconfig.test.json
// (noImplicitAny). The runtime is scripts/improve-report.mjs.
export function parseTestReport(text: string): { pass: number; fail: number };
export function testPassRate(text: string): number | null;
export function holdoutFilePassed(text: string): boolean;

// The stream surface, added 2026-09-07 with the container-isolated scorer. The
// holdout no longer writes a seekable report file the attempt can rewrite; the
// container emits one TAP stream on stdout with a trusted marker per case.
export const CASE_MARKER: string;
export function parseHoldoutStream(
  text: string,
  nonce?: string
): {
  cases: { name: string; passed: boolean }[];
  terminated: boolean;
};
export function holdoutPassCount(text: string, nonce?: string): number;

// The secondaries-in-the-container surface, added 2026-09-07. test_pass_rate and
// lint_count are recomputed inside the sandbox from the repo's own commands, so
// metrics.json is read for bundle_size_bytes and nothing else.
export interface SecondarySpec {
  trees: string[];
  test: string | null;
  lint: string | null;
  lint_pattern: string | null;
  verified: string | null;
}
export const SECONDARY_COMMANDS: Record<string, SecondarySpec>;

// The secondary metrics this scorer reports, in report order. Three since
// 2026-09-07: error_count and p95_latency_ms were removed because nothing ever
// measured them.
export const REPORTED_SECONDARY: string[];
export function markers(nonce?: string): {
  case: string;
  test: string;
  lint: string;
  status: string;
  end: string;
};
export function secondaryScripts(namespace: string): Record<string, string>;
export function splitStream(
  text: string,
  nonce?: string
): {
  segments: { kind: string; name: string; lines: string[]; status: number | null }[];
  terminated: boolean;
};
export function secondaryFromStream(
  text: string,
  namespace: string,
  nonce?: string
): { test_pass_rate: number | null; lint_count: number | null };
