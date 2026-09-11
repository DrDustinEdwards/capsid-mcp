import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_GRANTS,
  AGENT_KINDS,
  SCOPE_FLAGS,
  agentActor,
  allowsScope,
  defaultScopes,
  isAgentKind,
  mintAgentId,
  mintAgentKey,
  parseScopes,
  serializeScopes,
  type AgentScopes,
} from "../src/agents-schema.ts";
import { collectSourceFiles } from "./source-files.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// THE VOCABULARY OF A SCOPED CREDENTIAL, guarded the way every other list in this
// Worker is: the table, the tool and the enforcement point all read one module, and
// this file asserts that module against the migration that stores it.
//
// The property that matters most here is the one a scope system gets wrong silently:
// PARSING FAILS CLOSED. A scopes column that is empty, truncated, malformed, or
// carrying a type nobody expected has to resolve to the least privilege there is, not
// to "no restrictions found, allow everything". A permissive parse of a corrupt row is
// indistinguishable from a working one until the day it matters.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0008_agents.sql"), "utf8");

test("the migration and the module agree about the kinds a credential can have", () => {
  for (const kind of AGENT_KINDS) {
    assert.ok(MIGRATION.includes(kind), `migrations/0008_agents.sql never mentions the '${kind}' kind`);
  }
  assert.deepEqual([...AGENT_KINDS], ["session", "driver", "seat", "cron"]);
  assert.ok(isAgentKind("driver"));
  assert.ok(!isAgentKind("admin"), "'admin' is a synthetic identity, not a storable kind");
  assert.ok(!isAgentKind("constructor"), "the kind check must not answer for Object.prototype");
});

test("the migration declares every column the row type reads", () => {
  for (const column of ["id", "name", "kind", "key_hash", "scopes", "created_by", "created_at", "revoked_at", "last_seen"]) {
    assert.match(MIGRATION, new RegExp(`\\b${column}\\b`), `migrations/0008_agents.sql has no ${column} column`);
  }
  assert.match(MIGRATION, /name TEXT NOT NULL UNIQUE/, "agent names have to be unique: the name is the audit identity");
  assert.match(MIGRATION, /key_hash TEXT NOT NULL UNIQUE/, "two agents sharing a key hash would make the resolver ambiguous");
});

test("the default for a new agent is read on the named namespaces and nothing else", () => {
  const scopes = defaultScopes(["capsid"]);
  assert.deepEqual(scopes.namespaces, ["capsid"]);
  assert.deepEqual(scopes.grants, ["read"]);
  for (const flag of SCOPE_FLAGS) {
    assert.equal(scopes.flags[flag], false, `a new agent must not be born holding ${flag}`);
  }
});

test("a scopes column that cannot be read grants the least there is, never the most", () => {
  const leastPrivilege = (scopes: AgentScopes, why: string) => {
    assert.deepEqual(scopes.namespaces, [], why);
    assert.deepEqual(scopes.tools, [], why);
    assert.deepEqual(scopes.repos, [], why);
    assert.deepEqual(scopes.grants, [], why);
    for (const flag of SCOPE_FLAGS) assert.equal(scopes.flags[flag], false, `${why}: ${flag}`);
  };
  leastPrivilege(parseScopes(null), "a null scopes column");
  leastPrivilege(parseScopes(""), "an empty scopes column");
  leastPrivilege(parseScopes("{"), "a truncated scopes column");
  leastPrivilege(parseScopes("null"), "the JSON literal null");
  leastPrivilege(parseScopes("[]"), "an array where an object belongs");
  leastPrivilege(parseScopes('"*"'), "a bare string, which a loose parse could read as allow-all");
  leastPrivilege(parseScopes("{}"), "an object with no keys");
});

test("an unrecognised grant, flag or list entry is dropped rather than carried", () => {
  const scopes = parseScopes(
    JSON.stringify({
      namespaces: ["capsid", 7, null],
      repos: "*",
      tools: "*",
      grants: ["read", "admin", "write"],
      flags: { can_merge: true, can_fly: true, can_dispatch: "yes" },
    })
  );
  assert.deepEqual(scopes.namespaces, ["capsid"], "non-string entries are not namespaces");
  assert.deepEqual(scopes.grants, ["read", "write"], "'admin' is not a grant this system has");
  assert.equal(scopes.flags.can_merge, true);
  assert.equal(scopes.flags.can_dispatch, false, "a flag is true only when it is the boolean true");
  assert.ok(!Object.hasOwn(scopes.flags, "can_fly"), "an invented flag must not survive the parse");
});

test("serialize and parse round-trip without widening", () => {
  const scopes = defaultScopes(["capsid", "foxing"]);
  scopes.flags.can_merge = true;
  const back = parseScopes(serializeScopes(scopes));
  assert.deepEqual(back, scopes);
});

test("allowsScope is the one list comparison, and '*' is the only wildcard", () => {
  assert.equal(allowsScope("*", "anything"), true);
  assert.equal(allowsScope(["capsid"], "capsid"), true);
  assert.equal(allowsScope(["capsid"], "foxing"), false);
  assert.equal(allowsScope([], "capsid"), false, "an empty list allows nothing, which is what makes the fail-closed parse work");
  assert.equal(allowsScope(["*"], "capsid"), false, "a list containing the string '*' is a list of one odd name, not a wildcard");
});

test("ids and keys are minted, not sequential, and a key is not its own hash", () => {
  const id = mintAgentId();
  assert.match(id, /^agent_[0-9a-f]{12}$/);
  assert.notEqual(id, mintAgentId());
  const key = mintAgentKey();
  assert.match(key, /^capsid_agent_[0-9a-f]{64}$/, "32 bytes of entropy, prefixed so a leaked key is greppable");
  assert.notEqual(key, mintAgentKey());
});

test("the audit identity of an agent is its name, in the actor vocabulary the queue already speaks", () => {
  assert.equal(agentActor("capsid-driver"), "agent:capsid-driver");
});

test("the flag LIST lives in one module, and only the enforcement point names individual flags", () => {
  // The same rule the roster, the job statuses and the protected paths run on: one
  // list, imported everywhere. A second copy is what lets an enforcement point check
  // five of six flags for a year without anybody noticing.
  //
  // Naming an individual flag is different from re-deriving the list, and src/scope.ts
  // has to name them: it is where a flag is mapped to the call that needs it. So the
  // rule is that it is the ONLY module allowed to, and TypeScript closes the other
  // half, because both places that name flags are keyed by ScopeFlag and a missing or
  // invented one does not compile.
  const offenders = collectSourceFiles(join(import.meta.dirname, "..", "src"))
    .filter((f) => f.name !== "agents-schema.ts" && f.name !== "scope.ts")
    .filter((f) => SCOPE_FLAGS.some((flag) => new RegExp(`["']${flag}["']`).test(f.text)))
    .map((f) => f.name);
  assert.deepEqual(offenders, [], `these modules name a scope flag outside the enforcement point: ${offenders.join(", ")}`);
  // Vacuity: the scan can actually find a flag where one is supposed to be.
  const scope = collectSourceFiles(join(import.meta.dirname, "..", "src")).find((f) => f.name === "scope.ts");
  assert.ok(scope && /["']can_merge["']/.test(scope.text), "the scan found no flag name in src/scope.ts, so it is reading nothing");
});

test("the grant list is the two this Worker has always had", () => {
  assert.deepEqual([...AGENT_GRANTS], ["read", "write"]);
});
