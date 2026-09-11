import { sha256Hex } from "./auth";
import {
  AGENT_GRANTS,
  AGENT_KINDS,
  SCOPE_FLAGS,
  defaultScopes,
  isAgentKind,
  mintAgentId,
  mintAgentKey,
  parseScopes,
  serializeScopes,
  type AgentGrant,
  type AgentKind,
  type AgentRow,
  type AgentScopes,
} from "./agents-schema";

// THE CONTROL PLANE FOR CREDENTIALS: mint, list, revoke, re-scope.
//
// ADMIN ONLY, all four, enforced by the tool in src/tools/agents.ts. A minted agent
// that can mint another has a privilege escalation with no ceiling: a driver scoped
// to one namespace mints itself a seat scoped to all of them, and every scope below
// that becomes decoration. `admin` is deliberately NOT a flag, because a flag is
// settable by update_scopes, which is the same escalation one step further out.
//
// Separate from src/agents.ts, which is the RESOLVER. The resolver runs on every
// request and reads; this runs when a human changes the credential inventory and
// writes. Keeping them apart is what lets the resolver stay a read.

export interface AgentResult {
  ok: boolean;
  action: string;
  agent?: PublicAgent;
  agents?: PublicAgent[];
  key?: string;
  note?: string;
  scopes?: AgentScopes;
  refusal?: string;
}

// What an agent looks like to a reader. The stored verifier never appears: what is
// shown instead is the first twelve hex of it, the same shape the operator-key
// fingerprint has, so an agent can be matched against an audit row without the
// database handing out the thing it authenticates with.
export interface PublicAgent {
  id: string;
  name: string;
  kind: AgentKind;
  fingerprint: string;
  scopes: AgentScopes;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  last_seen: string | null;
}

function publicAgent(row: AgentRow): PublicAgent {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    fingerprint: row.key_hash.slice(0, 12),
    scopes: parseScopes(row.scopes),
    created_by: row.created_by,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    last_seen: row.last_seen,
  };
}

function refuse(action: string, refusal: string): AgentResult {
  return { ok: false, action, refusal };
}

function auditStatement(db: D1Database, actor: string, action: string, name: string, params: Record<string, unknown>) {
  // namespace and path are the audit table's addressing columns, and an agent is not
  // a document, so the agent's NAME goes in the path slot under a fixed "agents"
  // namespace. One audit table rather than a second log nobody reads.
  return db
    .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, 'agents', ?3, ?4)")
    .bind(actor, action, name, JSON.stringify(params));
}

async function liveAgentByName(db: D1Database, name: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE name = ?1 AND revoked_at IS NULL").bind(name).first<AgentRow>();
}

export interface ScopeArgs {
  namespaces?: string[];
  repos?: string[];
  tools?: string[];
  grants?: string[];
  flags?: Record<string, unknown>;
}

// A list of exactly ["*"] is the wildcard; anything else is a list of names. Spelled
// once, because a mint and a re-scope both accept it and disagreeing about it would
// mean one of them silently narrowing a caller to a namespace literally named "*".
function scopeList(names: string[]): "*" | string[] {
  return names.length === 1 && names[0] === "*" ? "*" : [...names];
}

// Applies the narrowing a mint or a re-scope asked for, on top of a base. EVERY AXIS
// IS OPTIONAL AND AN OMITTED AXIS KEEPS ITS BASE VALUE, so a call naming one flag
// does not silently clear the others, and a call naming none cannot widen anything.
function applyScopes(base: AgentScopes, args: ScopeArgs): AgentScopes {
  const scopes: AgentScopes = { ...base, flags: { ...base.flags } };
  if (args.namespaces) scopes.namespaces = scopeList(args.namespaces);
  if (args.repos) scopes.repos = scopeList(args.repos);
  if (args.tools) scopes.tools = scopeList(args.tools);
  if (args.grants) scopes.grants = args.grants.filter((g): g is AgentGrant => (AGENT_GRANTS as readonly string[]).includes(g));
  if (args.flags) {
    for (const flag of SCOPE_FLAGS) {
      if (Object.hasOwn(args.flags, flag)) scopes.flags[flag] = args.flags[flag] === true;
    }
  }
  return scopes;
}

export async function mintAgent(db: D1Database, actor: string, args: ScopeArgs & { name: string; kind: string }): Promise<AgentResult> {
  const name = args.name.trim();
  if (!name) return refuse("mint", "an agent needs a name: it is the audit identity every row it writes carries.");
  if (!isAgentKind(args.kind)) {
    return refuse("mint", `'${args.kind}' is not an agent kind. One of: ${AGENT_KINDS.join(", ")}.`);
  }
  if (!args.namespaces || args.namespaces.length === 0) {
    return refuse(
      "mint",
      "mint needs at least one namespace. A new agent is scoped to the namespaces it was named for, so minting one with none creates a credential that reaches nothing and says nothing about what it was for. Pass the single entry * deliberately if every namespace is what you mean."
    );
  }
  // NAMES ARE NEVER REUSED, revoked ones included, so the check is over every row
  // rather than the live ones. An audit row saying agent:capsid-driver has to mean
  // one credential forever, or the log stops being able to answer who did something.
  const existing = await db.prepare("SELECT id FROM agents WHERE name = ?1").bind(name).first<{ id: string }>();
  if (existing) {
    return refuse("mint", `an agent named '${name}' already exists (${existing.id}). A name is an audit identity and is never reused, including after a revoke.`);
  }
  const scopes = applyScopes({ ...defaultScopes([]), namespaces: scopeList(args.namespaces) }, { ...args, namespaces: undefined });
  // THE KEY EXISTS IN THIS FUNCTION AND NOWHERE ELSE. It is returned once; what is
  // stored, logged and read back is its sha256.
  const key = mintAgentKey();
  const keyHash = await sha256Hex(key);
  const row: AgentRow = {
    id: mintAgentId(),
    name,
    kind: args.kind,
    key_hash: keyHash,
    scopes: serializeScopes(scopes),
    created_by: actor,
    created_at: new Date().toISOString(),
    revoked_at: null,
    last_seen: null,
  };
  await db.batch([
    db
      .prepare("INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(row.id, row.name, row.kind, row.key_hash, row.scopes, row.created_by, row.created_at),
    auditStatement(db, actor, "agent-minted", name, { id: row.id, kind: row.kind, key_fingerprint: keyHash.slice(0, 12), scopes }),
  ]);
  return {
    ok: true,
    action: "mint",
    agent: publicAgent(row),
    key,
    scopes,
    note: "This key is shown ONCE and is stored nowhere: the table holds its sha256. Save it now. If it is lost, revoke this agent and mint another.",
  };
}

export async function listAgents(db: D1Database): Promise<AgentResult> {
  // REVOKED ROWS ARE INCLUDED. A credential that was revoked is exactly what an
  // inventory is read for, and hiding it would make "revoked" and "never existed"
  // look the same to whoever is auditing.
  const { results } = await db.prepare("SELECT * FROM agents ORDER BY created_at DESC, name").all<AgentRow>();
  return { ok: true, action: "list", agents: (results ?? []).map(publicAgent) };
}

export async function revokeAgent(db: D1Database, actor: string, name: string): Promise<AgentResult> {
  const row = await liveAgentByName(db, name);
  if (!row) return refuse("revoke", `no live agent named '${name}'. Call list to see the inventory, revoked ones included.`);
  // A keyed UPDATE with RETURNING, the rule the queue and the improve state machine
  // already run on: no row back means somebody else got there first, and reporting
  // success over that would be a lie about a credential.
  const won = await db
    .prepare("UPDATE agents SET revoked_at = datetime('now') WHERE id = ?1 AND revoked_at IS NULL RETURNING id")
    .bind(row.id)
    .first<{ id: string }>();
  if (!won) return refuse("revoke", `'${name}' was revoked by somebody else between reading it and revoking it.`);
  await db.batch([auditStatement(db, actor, "agent-revoked", name, { id: row.id, scopes: parseScopes(row.scopes) })]);
  return { ok: true, action: "revoke", agent: { ...publicAgent(row), revoked_at: new Date().toISOString() } };
}

export async function updateAgentScopes(db: D1Database, actor: string, name: string, args: ScopeArgs): Promise<AgentResult> {
  const row = await liveAgentByName(db, name);
  if (!row) return refuse("update_scopes", `no live agent named '${name}'. Call list to see the inventory, revoked ones included.`);
  const before = parseScopes(row.scopes);
  const scopes = applyScopes(before, args);
  const won = await db
    .prepare("UPDATE agents SET scopes = ?2 WHERE id = ?1 AND revoked_at IS NULL RETURNING id")
    .bind(row.id, serializeScopes(scopes))
    .first<{ id: string }>();
  if (!won) return refuse("update_scopes", `'${name}' was revoked between reading it and re-scoping it.`);
  // BOTH SIDES IN THE AUDIT ROW. "What are this agent's scopes now" is answerable
  // from the table. "What were they yesterday, and who widened them" is answerable
  // only if the row that changed them recorded what it changed from.
  await db.batch([auditStatement(db, actor, "agent-rescoped", name, { id: row.id, before, after: scopes })]);
  return { ok: true, action: "update_scopes", agent: { ...publicAgent(row), scopes }, scopes };
}
