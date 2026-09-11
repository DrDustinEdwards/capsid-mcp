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
// `registered` is the namespaces the Capsid store actually knows, fetched by the
// caller and passed in so selection stays pure. Omitting it keeps the old
// behaviour: only AGENTS matches, which is the direction that cannot widen a mint.
export function selectAgents(namespace?: string, registered?: string[]): typeof AGENTS;
export function driverFor(namespace: string): (typeof AGENTS)[number];
export function parseNamespaces(text: string): string[];
export function parseArgs(argv: string[]): { apply: boolean; namespace: string | undefined };
