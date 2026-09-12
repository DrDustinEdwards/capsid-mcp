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
// A NAMED ROLE. Separate from AGENTS because it is asked for by name rather than
// selected by namespace; see the comment over ROLES in the .mjs.
export const ROLES: Array<{
  name: string;
  kind: string;
  namespaces: string[];
  repos: string[];
  grants: string[];
  tools?: string[];
  flags?: Record<string, boolean>;
  what: string;
}>;
export function roleMintCommand(role: (typeof ROLES)[number]): string;
// `registered` is the namespaces the Capsid store actually knows, fetched by the
// caller and passed in so selection stays pure. Omitting it keeps the old
// behaviour: only AGENTS matches, which is the direction that cannot widen a mint.
// `role` selects by name from ROLES instead, and the return type is the union
// because the two lists are different shapes and pretending otherwise would hide a
// missing axis at the call site that mints.
export function selectAgents(
  namespace?: string,
  registered?: string[],
  role?: string
): Array<(typeof AGENTS)[number] | (typeof ROLES)[number]>;
export function driverFor(namespace: string): (typeof AGENTS)[number];
export function parseNamespaces(text: string): string[];
export function parseArgs(argv: string[]): {
  apply: boolean;
  namespace: string | undefined;
  role: string | undefined;
  roles: boolean;
};
