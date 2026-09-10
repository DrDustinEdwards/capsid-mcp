// Types for the scorer copier, so test/sync-scorer.test.ts type-checks under
// tsconfig.test.json (noImplicitAny). The runtime is scripts/sync-scorer.mjs.
export const MARKER: string;
export const WORKFLOW: string;
export const REPORT: string;
export function splitBlock(text: string, label: string): { head: string; tail: string };
export function normalize(text: string): string;
export function blockHash(text: string): string;
