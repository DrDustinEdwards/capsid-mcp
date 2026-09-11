import { bytesToHex } from "./encoding";

// THE VOCABULARY OF A SCOPED CREDENTIAL, in one module so the table
// (migrations/0008_agents.sql), the tool (src/tools/agents.ts) and the one
// enforcement point (src/scope.ts) cannot disagree about it. Same reasoning as
// jobs-schema.ts and improve-schema.ts: a list spelled twice is a list that drifts,
// and the copy nobody looked at is the one that checks five flags out of six.
//
// Kept free of Worker and MCP imports so the scope logic is unit-testable under
// node, the way src/auth.ts is.

// Descriptive, not authorizing. What an agent may do lives in its scopes and
// nowhere else, so a kind cannot quietly become a second permission system.
export const AGENT_KINDS = ["session", "driver", "seat", "cron"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// The two grants this Worker has always had. `ro:` operator keys were "read" and a
// plain entry was "write"; an agent says the same thing as a list.
export const AGENT_GRANTS = ["read", "write"] as const;
export type AgentGrant = (typeof AGENT_GRANTS)[number];

// THE FLAGS ARE THE BLAST RADIUS, not the day-to-day grant. Each one names an action
// whose consequence leaves this Worker: a merge can trigger a deploy on a repo that
// deploys on push, a direct write lands on a default branch with no review, a
// dispatch spends CI minutes, a workflow write edits what MEASURES the code, a
// protected path is what the improve loop may never touch, and a money path is a
// billing surface. `write` is not enough for any of them.
export const SCOPE_FLAGS = [
  "can_merge",
  "can_direct_write",
  "can_dispatch",
  "can_write_workflows",
  "can_touch_protected",
  "money_paths",
] as const;
export type ScopeFlag = (typeof SCOPE_FLAGS)[number];

// A list of names, or "*" for every name. The string "*" INSIDE a list is not a
// wildcard: it is a list of one oddly named thing, and treating it as a wildcard
// would make a typo in a mint command grant everything.
export type ScopeList = "*" | string[];

export interface AgentScopes {
  namespaces: ScopeList;
  repos: ScopeList;
  tools: ScopeList;
  grants: AgentGrant[];
  flags: Record<ScopeFlag, boolean>;
}

export interface AgentRow {
  id: string;
  name: string;
  kind: AgentKind;
  key_hash: string;
  scopes: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  last_seen: string | null;
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

function noFlags(): Record<ScopeFlag, boolean> {
  // Built fresh each time. A shared frozen object would be one mutation away from
  // handing every agent in the isolate a flag somebody set on one of them.
  const flags = {} as Record<ScopeFlag, boolean>;
  for (const flag of SCOPE_FLAGS) flags[flag] = false;
  return flags;
}

// EVERY FLAG OFF, NOTHING ALLOWED. The value parseScopes falls back to, and the
// reason a corrupt row is harmless rather than dangerous.
function emptyScopes(): AgentScopes {
  return { namespaces: [], repos: [], tools: [], grants: [], flags: noFlags() };
}

// THE DEFAULT FOR A NEW AGENT: read, on the namespaces it was named for, and no
// flags. Tools and repos are unrestricted because the grant already holds the line
// (a read grant cannot reach a write tool, and a repo read is a read); the axes that
// have to be narrowed at mint time are the ones the mint command asks for.
export function defaultScopes(namespaces: string[]): AgentScopes {
  return { namespaces: [...namespaces], repos: "*", tools: "*", grants: ["read"], flags: noFlags() };
}

function parseList(value: unknown): ScopeList {
  if (value === "*") return "*";
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

// FAILS CLOSED, and that is the whole point of this function. A scopes column that is
// null, empty, truncated, an array, a bare string or an object with none of the keys
// resolves to emptyScopes(): no namespaces, no tools, no repos, no grants, no flags.
// A permissive parse of a corrupt row is indistinguishable from a working one right
// up until the row is corrupt, which is the shape of failure this Worker has already
// paid for twice (the tsconfig no-op, the backup table list).
export function parseScopes(json: string | null | undefined): AgentScopes {
  if (!json) return emptyScopes();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptyScopes();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyScopes();
  const record = raw as Record<string, unknown>;
  const grants = Array.isArray(record.grants)
    ? (record.grants.filter((g): g is AgentGrant => (AGENT_GRANTS as readonly unknown[]).includes(g)) as AgentGrant[])
    : [];
  const flags = noFlags();
  // Only the flags this system has, and only the boolean true. A string "yes" is not
  // a flag, and an invented name does not survive the parse, so a scopes blob written
  // by hand cannot smuggle in an axis the enforcement point has never heard of.
  const rawFlags = typeof record.flags === "object" && record.flags !== null ? (record.flags as Record<string, unknown>) : {};
  for (const flag of SCOPE_FLAGS) flags[flag] = rawFlags[flag] === true;
  return {
    namespaces: parseList(record.namespaces),
    repos: parseList(record.repos),
    tools: parseList(record.tools),
    grants,
    flags,
  };
}

export function serializeScopes(scopes: AgentScopes): string {
  return JSON.stringify(scopes);
}

// The one list comparison. "*" is the only wildcard and it is the whole value, never
// an entry.
export function allowsScope(list: ScopeList, value: string): boolean {
  return list === "*" ? true : list.includes(value);
}

// How a scope list reads in a refusal. A refusal that says "not in scope" without
// saying what the scope IS costs the reader a round trip.
export function describeScope(list: ScopeList): string {
  if (list === "*") return "*";
  return list.length === 0 ? "(none)" : list.join(", ");
}

// agent_<12 hex>. See the migration for why it is not a sequence.
export function mintAgentId(): string {
  return `agent_${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
}

// 32 bytes of entropy behind a greppable prefix, so a key pasted into a file, a log
// or a commit is findable by searching for one string. Returned ONCE by the mint
// action and stored nowhere: what the table holds is its sha256.
export function mintAgentKey(): string {
  return `capsid_agent_${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// The audit identity, in the vocabulary audit_log.actor and jobs.claimed_by already
// speak (`github:<login>`, `opkey:<fingerprint>`). The name is UNIQUE in the table,
// so this string identifies exactly one agent row.
export function agentActor(name: string): string {
  return `agent:${name}`;
}

// THE DRIVER BOOTSTRAP INSTRUCTION, IN ONE PLACE.
//
// register_namespace does NOT mint the new namespace's driver agent, and the
// reason is a scope boundary rather than an omission. register_namespace runs on
// a plain write grant (src/scope.ts), which every driver agent holds, while
// minting is admin only (src/tools/agents.ts) precisely so that an agent cannot
// widen itself. A register path that minted and returned a key would hand any
// driver a fresh write credential for a namespace of its choosing, and every
// scope below it would become decoration.
//
// So it returns the COMMAND instead. No credential crosses the tool boundary, the
// admin runs one line, and the key goes from the mint response to a 0600 file
// without passing through a chat or a terminal. test/register-namespace-mint.test.ts
// asserts this string is parseable by the script it names.
export function driverAgentName(namespace: string): string {
  return `${namespace}-driver`;
}

export function driverKeyPath(namespace: string): string {
  return `~/.capsid/agent-${driverAgentName(namespace)}.key`;
}

export function driverMintInstruction(namespace: string): string {
  return (
    `Mint its driver agent as the admin: node scripts/mint-agents.mjs --namespace ${namespace} --apply. ` +
    `The key is returned once and lands in ${driverKeyPath(namespace)} at mode 0600. ` +
    `register_namespace does not mint it: minting is admin only, and this tool takes a plain write grant.`
  );
}
