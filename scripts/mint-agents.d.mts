// Types for the agent minter, so test/mint-agents.test.ts type-checks under
// tsconfig.test.json (noImplicitAny). The runtime is scripts/mint-agents.mjs.
export const ORIGIN_DEFAULT: string;
export const AGENTS: Array<{
  name: string;
  kind: string;
  namespaces: string[];
  grants: string[];
  flags?: Record<string, boolean>;
}>;
export function keyDir(): string;
export function keyPath(name: string): string;
export function fingerprint(key: string): string;
export function selectAgents(namespace?: string): typeof AGENTS;
export function parseArgs(argv: string[]): { apply: boolean; namespace: string | undefined };
