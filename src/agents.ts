import { operatorIdentity, sha256Hex, timingSafeEqual } from "./auth";
import {
  AGENT_GRANTS,
  SCOPE_FLAGS,
  agentActor,
  parseScopes,
  type AgentGrant,
  type AgentKind,
  type AgentRow,
  type AgentScopes,
  type ScopeFlag,
} from "./agents-schema";

// AGENTS AS USERS: a bearer resolves to a CALLER, not to a tier.
//
// Before this module, `operatorIdentity` answered "write" or "read" plus twelve hex
// of the presented key's digest, and every headless caller in the portfolio spoke
// that two-word vocabulary. The audit log could say that a write happened and could
// not say whose credential did it beyond a fingerprint somebody had to recognise,
// and there was no way to hand the queue driver a credential that could work a job
// without also being able to merge a pull request into a repo that deploys on push.
//
// THREE KINDS OF CALLER RESOLVE HERE, and the order is load-bearing:
//
//   1. A MINTED AGENT (a row in `agents`), which carries exactly the scopes its row
//      says and nothing else. Checked FIRST, so a key that is somehow both an agent
//      and an OPERATOR_KEY_HASH entry gets the narrower authority rather than the
//      wider one.
//   2. A LEGACY OPERATOR KEY, which keeps the authority it has today: a plain entry
//      is write with every flag, an `ro:` entry is read with none. This is what lets
//      the table land without breaking the credential that would have to be used to
//      mint the first agent. It stops working when Dustin revokes it, not when this
//      code deploys.
//   3. THE OAUTH ADMIN SESSION, resolved in src/index.ts rather than here because
//      the provider has already done the work: it is the synthetic agent "admin",
//      holding every scope.

export interface Agent {
  // The agents.id for a minted agent. For a synthetic one, its actor string, so a
  // caller identity is always addressable by a single value.
  id: string;
  // The audit NAME. "admin" for an OAuth session, "opkey" for a legacy key, and the
  // row's unique name for a minted agent.
  name: string;
  kind: AgentKind;
  // What lands in audit_log.actor and jobs.claimed_by. `agent:<name>` for a minted
  // agent; the existing `github:<login>` and `opkey:<fingerprint>` for the two
  // identities that predate the table, because those are more specific than the
  // synthetic name and every audit query already reads them.
  actor: string;
  scopes: AgentScopes;
  // May this caller mint, revoke and re-scope other agents? TRUE only for the two
  // identities that predate the table (the OAuth admin and a legacy write key), so a
  // minted agent can never mint a wider one than itself. There is no flag for this:
  // a flag would be settable by update_scopes, which is the escalation this refuses.
  admin: boolean;
  // A row-backed agent, as opposed to a synthetic one. What last_seen is written for.
  row: AgentRow | null;
}

function flagsAll(value: boolean): Record<ScopeFlag, boolean> {
  const flags = {} as Record<ScopeFlag, boolean>;
  for (const flag of SCOPE_FLAGS) flags[flag] = value;
  return flags;
}

// Every namespace, every repo, every tool, both grants, every flag. What the two
// identities that predate the agents table have always had.
function unrestrictedScopes(): AgentScopes {
  return { namespaces: "*", repos: "*", tools: "*", grants: [...AGENT_GRANTS], flags: flagsAll(true) };
}

function readEverythingScopes(): AgentScopes {
  return { namespaces: "*", repos: "*", tools: "*", grants: ["read"], flags: flagsAll(false) };
}

// THE OAUTH ADMIN SESSION. The provider has already checked the GitHub login against
// ADMIN_GITHUB_LOGIN twice by the time this is called (once at consent, once per
// request as defence in depth), so this function grants rather than decides.
export function adminAgent(login: string): Agent {
  return {
    id: `github:${login}`,
    name: "admin",
    kind: "seat",
    actor: `github:${login}`,
    scopes: unrestrictedScopes(),
    admin: true,
    row: null,
  };
}

// THE LEGACY VOCABULARY AS A CALLER. A bare grant plus an actor string is what this
// Worker understood before the agents table, and expressing it as an Agent is what
// lets the one enforcement point be the only enforcement point: the fallback path
// and every existing test build a caller the same way the new path does, instead of
// there being a second code path where scopes do not apply.
export function legacyAgent(grant: AgentGrant, actor: string): Agent {
  return {
    id: actor,
    name: actor.includes(":") ? actor.slice(0, actor.indexOf(":")) : actor,
    kind: "session",
    actor,
    scopes: grant === "write" ? unrestrictedScopes() : readEverythingScopes(),
    // A write-grant operator key is what mints the first agents; a read-only one is
    // not.
    admin: grant === "write",
    row: null,
  };
}

function agentFromRow(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    actor: agentActor(row.name),
    scopes: parseScopes(row.scopes),
    admin: false,
    row,
  };
}

export interface ResolvedAgent {
  agent: Agent;
  // last_seen, written best effort AFTER the answer. Separate from resolution so the
  // request path is a read: a resolver that wrote on every call would put a D1 write
  // in front of every tool call, and a failed write would look like a failed auth.
  touch: () => Promise<void>;
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

// The lookup is an indexed equality on the digest, and the answer is then CONFIRMED
// with a constant-time compare. The index is what makes this O(1) as the table grows;
// the compare is what keeps the guarantee if that query is ever loosened (a LIKE, a
// case fold, a fake in a test). Neither leaks anything useful on its own: what is
// compared is a sha256 of the presented key against a sha256 the presenter would have
// to already hold to learn anything from the timing.
async function liveAgentByHash(db: D1Database, hash: string): Promise<AgentRow | null> {
  const row = await db
    .prepare("SELECT * FROM agents WHERE key_hash = ?1 AND revoked_at IS NULL")
    .bind(hash)
    .first<AgentRow>();
  if (!row) return null;
  return timingSafeEqual(row.key_hash, hash) ? row : null;
}

// A REVOKED AGENT DOES NOT FALL THROUGH. Its key stops resolving here and is not
// then offered to OPERATOR_KEY_HASH, because a key that was minted as an agent is
// not an operator key and the fallback is for credentials that predate the table.
// Falling through would make revocation depend on the key never having matched
// anything else.
export async function resolveAgent(request: Request, env: { DB: D1Database; OPERATOR_KEY_HASH?: string }): Promise<ResolvedAgent | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await liveAgentByHash(env.DB, hash);
  if (row) {
    const agent = agentFromRow(row);
    return { agent, touch: () => touchLastSeen(env.DB, agent) };
  }
  const revoked = await env.DB.prepare("SELECT id FROM agents WHERE key_hash = ?1").bind(hash).first<{ id: string }>();
  if (revoked) return null;
  const { grant, fingerprint } = await operatorIdentity(request, env);
  if (!grant || !fingerprint) return null;
  return { agent: legacyAgent(grant, `opkey:${fingerprint}`), touch: async () => {} };
}

// Best effort by design. A failure here means one stale last_seen, and last_seen is
// how an unused credential is noticed, not how a request is authorized.
async function touchLastSeen(db: D1Database, agent: Agent): Promise<void> {
  if (!agent.row) return;
  try {
    await db.prepare("UPDATE agents SET last_seen = datetime('now') WHERE id = ?1").bind(agent.id).run();
  } catch (err) {
    console.error(`AGENT_LAST_SEEN_FAILED ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
