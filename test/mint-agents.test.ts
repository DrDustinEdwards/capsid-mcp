import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS, driverFor, keyPath, parseArgs, parseNamespaces, selectAgents } from "../scripts/mint-agents.mjs";
import { ROSTER } from "../src/improve-schema.ts";

// scripts/mint-agents.mjs: the six credentials of docs/bootstrap.md.
//
// The roster is DERIVED from src/improve-schema.ts rather than retyped, so a
// sixth project joining the loop fails here instead of silently having no driver
// agent and no key file. That is the "derive the expected list from the source of
// truth" rule in capsid/conventions.md, and the direction that bites is the one
// where the roster grows.

test("every roster namespace has exactly one driver agent, named <ns>-driver", () => {
  for (const ns of ROSTER) {
    const drivers = AGENTS.filter((a) => a.kind === "driver" && a.namespaces.includes(ns));
    assert.equal(drivers.length, 1, `${ns} has ${drivers.length} driver agents`);
    assert.equal(drivers[0].name, `${ns}-driver`, `${ns}'s driver is named ${drivers[0].name}`);
  }
  // The other direction: no driver for a namespace that is not on the roster.
  const orphans = AGENTS.filter((a) => a.kind === "driver" && !a.namespaces.every((n) => (ROSTER as readonly string[]).includes(n)));
  assert.deepEqual(orphans.map((a) => a.name), [], "a driver is scoped to a namespace that is not on the roster");
  assert.equal(AGENTS.length, ROSTER.length + 1, "the set is one driver per roster namespace plus the seat");
});

test("a driver carries no flags, and only the seat may merge", () => {
  // The blast radius, asserted rather than described. A driver opens pull
  // requests; a human merges them.
  for (const a of AGENTS.filter((x) => x.kind === "driver")) {
    assert.deepEqual(a.flags ?? {}, {}, `${a.name} carries flags`);
    assert.deepEqual(a.grants, ["read", "write"]);
  }
  const seat = AGENTS.find((a) => a.kind === "seat");
  assert.ok(seat, "the seat is gone");
  assert.deepEqual(seat.namespaces, ["*"]);
  assert.deepEqual(seat.flags, { can_merge: true });
  // can_direct_write is off even for the seat, and the way to assert that without
  // naming an absent property is to pin the whole key set: anything granted later
  // shows up here as a new key rather than passing on a nullish default.
  assert.deepEqual(Object.keys(seat.flags ?? {}), ["can_merge"]);
});

test("--namespace selects one project without touching the rest", () => {
  const picked = selectAgents("foxing");
  assert.deepEqual(picked.map((a) => a.name), ["foxing-driver"]);
  // Omitted, it is the whole set: re-minting everything stays the default.
  assert.equal(selectAgents(undefined).length, AGENTS.length);
  // The seat is reachable by its own scope rather than by a special case.
  assert.deepEqual(selectAgents("*").map((a) => a.name), ["seat"]);
});

// ---- a registered namespace that is not on the roster ------------------------
//
// THE ROSTER IS NOT THE LIST OF NAMESPACES. AGENTS is derived from the improve
// roster, which is the five projects the loop proposes changes to. A namespace
// can own a repo and a job queue without joining that roster, and claude-skills
// is the first that does: it refused to mint until --namespace stopped treating
// the roster as the universe.

const REGISTERED = ["bsw", "capsid", "claude-skills", "dustinedwards", "foxhound", "foxing", "germomics", "julieedwards", "txasm"];

test("A REGISTERED NON-ROSTER NAMESPACE MINTS, with a driver of the roster shape", () => {
  const picked = selectAgents("claude-skills", REGISTERED);
  assert.equal(picked.length, 1, "one driver, not zero and not the whole set");
  const driver = picked[0];
  assert.equal(driver.name, "claude-skills-driver");
  assert.equal(driver.kind, "driver");
  assert.deepEqual(driver.namespaces, ["claude-skills"]);
  assert.deepEqual(driver.grants, ["read", "write"]);
  // The property that matters: a synthesized driver is not a wider credential
  // than a listed one. Compared against a real roster driver rather than against
  // a description of one, so the two cannot drift apart.
  const rosterDriver = AGENTS.find((a) => a.name === "foxing-driver");
  assert.deepEqual(Object.keys(driver).sort(), Object.keys(rosterDriver!).sort());
  assert.deepEqual(driver.flags ?? {}, {}, "a synthesized driver must carry no flags");
});

test("the namespace is confirmed REGISTERED, not merely well-formed", () => {
  // Registration is the authority. A plausible name that nobody registered is a
  // typo, and minting a credential for it would leave a live agent scoped to a
  // namespace that does not exist.
  assert.throws(() => selectAgents("claude-skilz", REGISTERED), /no agent is scoped to 'claude-skilz'/);
  assert.throws(() => selectAgents("claude-skilz", REGISTERED), /Registered in Capsid:.*claude-skills/);
});

test("WITHOUT a registered list, only AGENTS matches, so a failed lookup cannot widen the mint", () => {
  // The safe direction, asserted. An empty or absent list must never mint more
  // than the old behaviour did.
  assert.throws(() => selectAgents("claude-skills"), /no agent is scoped to 'claude-skills'/);
  assert.throws(() => selectAgents("claude-skills", []), /no agent is scoped to 'claude-skills'/);
  // And a roster namespace still resolves from AGENTS with no list at all.
  assert.deepEqual(selectAgents("foxing").map((a) => a.name), ["foxing-driver"]);
});

test("a roster namespace resolves to its LISTED agent, never a synthesized one", () => {
  // If a listed entry ever gains a flag or a different scope, the listed entry is
  // what must win. Passing a registered list that also contains it must not change
  // the answer.
  assert.deepEqual(selectAgents("foxing", REGISTERED), selectAgents("foxing"));
  for (const ns of ROSTER) {
    assert.deepEqual(selectAgents(ns, REGISTERED), AGENTS.filter((a) => a.namespaces.includes(ns)));
  }
});

test("driverFor is the one spelling of a driver", () => {
  const made = driverFor("txasm");
  assert.deepEqual(made, { name: "txasm-driver", kind: "driver", namespaces: ["txasm"], grants: ["read", "write"] });
});

test("parseNamespaces reads the real response shape, and refuses a changed one", () => {
  // The shape the namespaces tool actually returned on 2026-09-11: a bare array
  // of rows, each with a `namespace` key alongside repos and counts.
  const real = JSON.stringify([
    { namespace: "capsid", repos: "[]", created_at: "2026-07-06 20:06:59", unconsolidated: 6 },
    { namespace: "claude-skills", repos: "[]", created_at: "2026-09-11 06:33:45", unconsolidated: 0 },
  ]);
  assert.deepEqual(parseNamespaces(real), ["capsid", "claude-skills"]);
  // A shape change must be loud. An empty list would otherwise make every
  // --namespace refuse and read as "not registered".
  assert.throws(() => parseNamespaces("[]"), /response shape changed/);
  assert.throws(() => parseNamespaces('{"namespaces":["capsid"]}'), /not an array/);
  assert.throws(() => parseNamespaces("not json"), /did not answer with JSON/);
});

test("an unknown namespace is refused, and the refusal names the known ones", () => {
  // Matching nothing must not read as success: "minted 0 agents" and "minted the
  // one you meant" are the same output to a caller who is not counting.
  assert.throws(() => selectAgents("foxhoud"), /no agent is scoped to 'foxhoud'/);
  assert.throws(() => selectAgents("foxhoud"), /Known:.*foxhound/);
});

test("parseArgs reads --apply and --namespace, and refuses a bare --namespace", () => {
  assert.deepEqual(parseArgs([]), { apply: false, namespace: undefined, role: undefined, roles: false });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true, namespace: undefined, role: undefined, roles: false });
  assert.deepEqual(parseArgs(["--namespace", "capsid", "--apply"]), { apply: true, namespace: "capsid", role: undefined, roles: false });
  // A value-less flag would otherwise select every agent and mint the lot.
  assert.throws(() => parseArgs(["--namespace"]), /needs a value/);
});

test("parseArgs reads the role selectors, and refuses the two selectors together", () => {
  assert.deepEqual(parseArgs(["--role", "auditor", "--apply"]), { apply: true, namespace: undefined, role: "auditor", roles: false });
  assert.deepEqual(parseArgs(["--roles"]), { apply: false, namespace: undefined, role: undefined, roles: true });
  assert.throws(() => parseArgs(["--role"]), /needs a value/);
  // The two select different lists. Accepting both and preferring one would mint
  // something the caller did not name, which is the failure --namespace already
  // refuses for an unknown value.
  assert.throws(() => parseArgs(["--namespace", "capsid", "--role", "auditor"]), /one or the other/);
});

test("the key file path is the one docs/bootstrap.md and the driver both name", () => {
  // The driver refuses a namespace whose file is missing and names it, so this
  // shape is a contract between three places rather than a detail of this script.
  // Built with join() rather than matched with a regex, so it is the same answer
  // on the Windows workstation the driver runs on and the POSIX runner CI uses.
  const expected = (name: string) => join(homedir(), ".capsid", `agent-${name}.key`);
  assert.equal(keyPath("foxing-driver"), expected("foxing-driver"));
  for (const ns of ROSTER) {
    assert.equal(keyPath(`${ns}-driver`), expected(`${ns}-driver`));
  }
  assert.equal(keyPath("seat"), expected("seat"));
});
