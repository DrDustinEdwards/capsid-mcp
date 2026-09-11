import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { SCOPE_FLAGS, defaultScopes, type ScopeFlag } from "../src/agents-schema.ts";
import { adminAgent, type Agent } from "../src/agents.ts";
import { TOOL_GRANTS, repoWriteFlags } from "../src/scope.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";
import { sourceFile, toolBlocks } from "./source-files.ts";

// GROUP 6: THE BLAST-RADIUS SUITE.
//
// One plant per flag, driven through a REAL MCP connection against a scoped caller,
// and each plant is asserted in both directions: the agent WITHOUT the flag is
// refused, and the admin holding it is not.
//
// Both halves are load-bearing and they fail differently. A refusal test alone
// passes just as well against a tool that is broken for everybody, which is how a
// scope check becomes an outage nobody attributes to it. And a guard that fires on
// correct calls gets deleted rather than fixed, so the innocent direction is what
// keeps the refusing direction alive.
//
// THE STRONGEST ASSERTION HERE IS NOT THE REFUSAL, IT IS THAT NOTHING WAS FETCHED.
// A repo write that refuses after committing to GitHub has already happened; the
// refusal is then a description of the past. Every plant below asserts the GitHub
// call count is zero.

const REPOS = [{ repo: "o/r", label: "primary" }];

function env() {
  return fakeEnv({
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify(REPOS) }) }) }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

// A project driver as docs/bootstrap.md says to mint one: write on its own
// namespace, and not one flag.
function driver(namespace = "capsid", grant: ScopeFlag[] = []): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  for (const flag of grant) scopes.flags[flag] = true;
  return { id: "agent_0123456789ab", name: `${namespace}-driver`, kind: "driver", actor: `agent:${namespace}-driver`, scopes, admin: false, row: null };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(caller: Agent, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = buildServer(env(), caller);
  const client = new Client({ name: "blast-radius", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  await client.close();
  await server.close();
  return result;
}

// EVERY PATH THAT NEEDS A FLAG, one row each. The tool, the arguments that make the
// call need it, and the flag it needs. A row here is a plant: the driver is refused
// and the admin is not.
const PLANTS: Array<{ flag: ScopeFlag; tool: string; args: Record<string, unknown>; what: string }> = [
  {
    flag: "can_direct_write",
    tool: "write_repo_file",
    args: { namespace: "capsid", path: "src/thing.ts", content: "x", message: "m", mode: "direct" },
    what: "a direct-mode commit, which lands on the default branch with no review",
  },
  {
    flag: "can_direct_write",
    tool: "delete_repo_file",
    args: { namespace: "capsid", path: "src/thing.ts", message: "m", mode: "direct" },
    what: "a direct-mode delete, same branch and same absence of review",
  },
  {
    flag: "can_write_workflows",
    tool: "write_repo_file",
    args: { namespace: "capsid", path: ".github/workflows/ci.yml", content: "x", message: "m", allow_workflow_write: true },
    what: "a workflow write, which edits what MEASURES the code",
  },
  {
    flag: "can_merge",
    tool: "manage_pr",
    args: { namespace: "capsid", number: 7, action: "merge" },
    what: "a merge, which can trigger a deploy on a repo that deploys on push",
  },
  {
    flag: "can_dispatch",
    tool: "ci_dispatch",
    args: { namespace: "capsid", workflow: "verify.yml", ref: "master" },
    what: "a workflow dispatch, which spends CI minutes and runs code with the repo's secrets in scope",
  },
  {
    flag: "can_touch_protected",
    tool: "write_repo_file",
    args: { namespace: "capsid", path: "package.json", content: "{}", message: "m" },
    what: "a write to a protected path, which is what the improve loop may never touch at all",
  },
  {
    flag: "can_touch_protected",
    tool: "write_repo_file",
    args: { namespace: "capsid", path: "test/thing.test.ts", content: "x", message: "m" },
    what: "a write to a test, which is the measurement rather than the code",
  },
  {
    flag: "money_paths",
    tool: "write_repo_file",
    args: { namespace: "foxhound", path: "app/billing/charge.server.ts", content: "x", message: "m" },
    what: "a write to a billing path in foxhound, which is where a mistake costs real money",
  },
];

for (const plant of PLANTS) {
  test(`PLANT: without ${plant.flag}, a driver is refused ${plant.what}`, async () => {
    await withFetch({}, async (calls) => {
      // The driver is scoped to the namespace the call names, so the refusal that
      // comes back is about the FLAG and not about the namespace. A plant that
      // refuses for the wrong reason proves nothing.
      const caller = driver(String(plant.args.namespace));
      const result = await callAs(caller, plant.tool, plant.args);
      assert.equal(result.isError, true, `${plant.tool} was not refused without ${plant.flag}`);
      assert.match(result.content[0].text, new RegExp(`needs the ${plant.flag} flag`), `the refusal does not name ${plant.flag}: ${result.content[0].text}`);
      assert.equal(calls.length, 0, `${plant.tool} reached GitHub before refusing, so the refusal describes something that already happened`);
    });
  });

  test(`PLANT: the same call is NOT refused for a caller holding ${plant.flag}`, async () => {
    // The innocent direction. Without it, a tool broken for everybody passes the
    // test above. The call is allowed to fail afterwards for its own reasons (the
    // fetch harness has no routes), which is why this asserts on the refusal TEXT
    // rather than on success: what must not appear is the scope refusal.
    await withFetch({}, async () => {
      const result = await callAs(adminAgent("DrDustinEdwards"), plant.tool, plant.args);
      const text = result.content[0]?.text ?? "";
      assert.doesNotMatch(text, /needs the .* flag/, `the admin was refused a flag it holds: ${text}`);
      assert.doesNotMatch(text, /unauthorized:/, `the admin was refused: ${text}`);
    });
  });
}

test("PLANT: a driver IS allowed the pull-request path, which is the whole point of scoping it this way", async () => {
  // The shape docs/bootstrap.md prescribes has to actually work, or the advice is to
  // mint a credential that cannot do its job. A pr-mode write needs no flag at all.
  await withFetch({}, async (calls) => {
    const result = await callAs(driver(), "write_repo_file", {
      namespace: "capsid",
      path: "src/thing.ts",
      content: "x",
      message: "m",
      mode: "pr",
    });
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, /unauthorized:/, `a pr-mode write was refused for a driver: ${text}`);
    assert.ok(calls.length > 0, "the call never reached GitHub, so this asserts nothing about the guard");
  });
});

test("PLANT: a driver cannot reach a namespace it was not minted for", async () => {
  await withFetch({}, async (calls) => {
    const result = await callAs(driver("capsid"), "write_repo_file", {
      namespace: "foxing",
      path: "src/thing.ts",
      content: "x",
      message: "m",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not scoped to the 'foxing' namespace/);
    assert.equal(calls.length, 0, "the refused call still reached GitHub");
  });
});

test("PLANT: a namespace-scoped caller that omits the namespace is refused, not silently given all of them", async () => {
  // The hole this closes: `list` and `search` treat an omitted namespace as every
  // namespace, so a narrowed caller that leaves it out would read the whole store
  // with no check having failed anywhere.
  const result = await callAs(driver(), "list", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must name a namespace/);

  // And naming one it holds still works, or the rule is just an outage. This one
  // needs a store that can answer a multi-row read, so it uses the shared fake
  // rather than the one-row repo stub the flag plants run against.
  const d1 = fakeD1({ documents: [{ namespace: "capsid", path: "core.md", title: "core" }] });
  const server = buildServer(fakeEnv({ DB: d1.db }), driver());
  const client = new Client({ name: "blast-radius", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const allowed = (await client.callTool({ name: "list", arguments: { namespace: "capsid" } })) as ToolResult;
  await client.close();
  await server.close();
  assert.notEqual(allowed.isError, true, allowed.content[0]?.text);
  assert.match(allowed.content[0].text, /core\.md/, "the allowed read came back empty, so it proves nothing about the guard");
});

test("PLANT: an unscoped tool is refused even when the grant and the namespace are fine", async () => {
  const narrow = driver();
  narrow.scopes.tools = ["read", "search", "write"];
  const result = await callAs(narrow, "manage_pr", { namespace: "capsid", number: 7, action: "close" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not scoped to the 'manage_pr' tool/);
});

// ---- the derived half --------------------------------------------------------

test("DERIVED: every write tool is on the enforcement point's path", () => {
  // Not a list of tools somebody remembered to check. The registrations are walked,
  // and each write tool must be covered by the registrar (its requirement is stated)
  // or carry its own check. A tool added tomorrow is in this set the moment it is
  // registered.
  const uncovered = toolBlocks()
    .filter((b) => TOOL_GRANTS[b.name] !== "read")
    .filter((b) => !Object.hasOwn(TOOL_GRANTS, b.name) || (TOOL_GRANTS[b.name] === "action" && !/ctx\.scope\(/.test(b.body)))
    .map((b) => b.name);
  assert.deepEqual(uncovered, [], `these write tools are not covered by checkScope: ${uncovered.join(", ")}`);
  // Vacuity: the walk found a real surface.
  assert.ok(toolBlocks().length >= 30, "the tool walk collapsed");
});

test("DERIVED: every repo mutation goes through the one wrapper that computes the flags", () => {
  // The seven repo write tools reach GitHub through guardedWrite, which is where
  // repoWriteFlags runs. A tool calling a github.ts mutation directly would skip the
  // flag check entirely while still being write-gated at the registrar, and that is
  // the failure this derivation exists to catch.
  const repo = sourceFile("tools/repo.ts");
  const MUTATIONS = ["writeRepoFile(", "deleteRepoFile(", "createBranch(", "openPr(", "managePr(", "deleteBranch(", "ciDispatch("];
  for (const mutation of MUTATIONS) {
    let from = 0;
    let seen = 0;
    for (;;) {
      const at = repo.indexOf(mutation, from);
      if (at === -1) break;
      from = at + mutation.length;
      // Skip the import list at the top of the file, which names each of them once.
      if (at < repo.indexOf("export function registerRepoTools")) continue;
      seen += 1;
      const block = repo.slice(Math.max(0, at - 800), at);
      assert.match(
        block,
        /guardedWrite\(/,
        `${mutation} is called at index ${at} without going through guardedWrite, so no flag is checked for it`
      );
    }
    assert.ok(seen > 0, `the scan found no call to ${mutation}; it is reading nothing`);
  }
});

test("DERIVED: every flag is reachable, so none of them is decoration", () => {
  // A flag nothing ever asks for is a checkbox that reads as protection and is not.
  // Each one has to be produced by repoWriteFlags for some call, or be named by the
  // document-side override, which is the only other place a flag is required.
  const produced = new Set<ScopeFlag>();
  for (const plant of PLANTS) {
    for (const flag of repoWriteFlags(plant.tool, plant.args as { path?: string; mode?: string; action?: string; allow_workflow_write?: boolean })) {
      produced.add(flag);
    }
  }
  const docs = sourceFile("tools/docs.ts");
  const scope = sourceFile("scope.ts");
  for (const flag of SCOPE_FLAGS) {
    const named = produced.has(flag) || docs.includes("IMPROVE_OVERRIDE_FLAGS") && scope.includes(`"${flag}"`);
    assert.ok(named, `${flag} is required by no path, so holding it or not changes nothing`);
  }
  // And specifically: the one flag not produced by a repo write is required by the
  // document-side override, rather than merely being mentioned somewhere.
  assert.match(scope, /IMPROVE_OVERRIDE_FLAGS = /);
});
