import assert from "node:assert/strict";
import { test } from "node:test";
import { driverAgentName, driverKeyPath, driverMintInstruction } from "../src/agents-schema.ts";
import { keyPath, parseArgs, selectAgents } from "../scripts/mint-agents.mjs";
import { TOOL_GRANTS } from "../src/scope.ts";
import { sep } from "node:path";
import { sourceFile } from "./source-files.ts";

// register_namespace RETURNS THE MINT COMMAND AND DOES NOT MINT (2026-09-11).
//
// The seam this closes: register_namespace takes a plain "write" grant, which
// every driver agent holds, while minting is gated on agent.admin so that an
// agent cannot widen itself. Minting inside register would have handed any driver
// a fresh write credential for a namespace of its choosing.

test("the premise still holds: register_namespace is write, not admin", () => {
  // If this ever became admin-only the reasoning above changes, and whoever
  // changes it should be told by a test rather than discover it in a review.
  assert.equal(TOOL_GRANTS.register_namespace, "write");
  assert.equal(TOOL_GRANTS.agents, "write");
  // The admin gate on minting lives in the handler, not in TOOL_GRANTS. Named
  // exactly via sourceFile(): a find() over the walk matches top-level
  // src/agents.ts first, which does not carry the gate, and the assertion then
  // reports on a file it was never about. That is how this test first passed.
  assert.match(sourceFile("tools/agents.ts"), /agent[.]admin/, "the admin gate on minting is gone");
});

test("register_namespace's handler does not mint", () => {
  const docs = sourceFile("tools/docs.ts");
  const start = docs.indexOf('"register_namespace"');
  const end = docs.indexOf('"update_namespace"', start);
  assert.ok(start !== -1 && end > start, "could not isolate the register_namespace registration");
  const handler = docs.slice(start, end);
  assert.doesNotMatch(handler, /mintAgent|action:\s*["']mint["']/, "register_namespace mints an agent");
  assert.match(handler, /driverMintInstruction/, "register_namespace no longer returns the mint instruction");
  assert.match(handler, /driver_agent:\s*null/, "the response no longer states that nothing was minted");
});

test("the instruction it prints is parseable by the script it names", () => {
  // The failure this prevents: the tool tells a human to run a flag the script
  // does not have. Both halves are derived rather than retyped.
  const instruction = driverMintInstruction("txasm");
  const match = instruction.match(/node scripts\/mint-agents\.mjs ([^.]+)\./);
  assert.ok(match, `no runnable command found in: ${instruction}`);
  const argv = match[1].trim().split(/\s+/);
  const parsed = parseArgs(argv);
  assert.equal(parsed.apply, true, "the printed command would only dry run");
  assert.equal(parsed.namespace, "txasm");
});

test("the path it names is the path the script writes", () => {
  for (const ns of ["txasm", "foxing", "capsid"]) {
    const named = driverKeyPath(ns);
    assert.equal(named, `~/.capsid/agent-${ns}-driver.key`);
    // Same file, expressed absolutely by the script. Compare the tail, since one
    // side is tilde-relative by design (it goes in front of a human).
    const absolute = keyPath(driverAgentName(ns)).split(sep).join("/");
    assert.ok(absolute.endsWith(named.slice(1)), `${absolute} is not ${named}`);
  }
});

test("a roster namespace's instruction selects exactly that one agent", () => {
  // Ties the three together: the name register_namespace would use, the selector
  // the script parses, and the agent the script would actually mint.
  const found = driverMintInstruction("foxing").match(/mint-agents[.]mjs ([^.]+)[.]/);
  assert.ok(found, "the instruction carries no runnable command");
  const parsed = parseArgs(found[1].trim().split(/\s+/));
  const picked = selectAgents(parsed.namespace);
  assert.deepEqual(picked.map((a) => a.name), [driverAgentName("foxing")]);
});
