// Types for the trusted scorer glue, so test/improve-report.test.ts type-checks
// under tsconfig.test.json (noImplicitAny). The runtime is scripts/improve-report.mjs.
export function parseTestReport(text: string): { pass: number; fail: number };
export function testPassRate(text: string): number | null;
export function holdoutFilePassed(text: string): boolean;
