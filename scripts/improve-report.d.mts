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
export function parseHoldoutStream(text: string): {
  cases: { name: string; passed: boolean }[];
  terminated: boolean;
};
export function holdoutPassCount(text: string): number;
