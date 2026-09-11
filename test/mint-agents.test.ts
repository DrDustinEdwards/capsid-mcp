import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS, keyPath, parseArgs, selectAgents } from "../scripts/mint-agents.mjs";
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

test("an unknown namespace is refused, and the refusal names the known ones", () => {
  // Matching nothing must not read as success: "minted 0 agents" and "minted the
  // one you meant" are the same output to a caller who is not counting.
  assert.throws(() => selectAgents("foxhoud"), /no agent is scoped to 'foxhoud'/);
  assert.throws(() => selectAgents("foxhoud"), /Known:.*foxhound/);
});

test("parseArgs reads --apply and --namespace, and refuses a bare --namespace", () => {
  assert.deepEqual(parseArgs([]), { apply: false, namespace: undefined });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true, namespace: undefined });
  assert.deepEqual(parseArgs(["--namespace", "capsid", "--apply"]), { apply: true, namespace: "capsid" });
  // A value-less flag would otherwise select every agent and mint the lot.
  assert.throws(() => parseArgs(["--namespace"]), /needs a value/);
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
