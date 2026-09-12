// Mint the agents docs/bootstrap.md describes and write each key to
// ~/.capsid/agent-<name>.key, mode 0600.
//
// The key is printed NOWHERE. It goes from the mint response straight to the
// file, and this script reports the name and a 12-hex fingerprint of the digest.
// That is deliberate and it is the whole point: docs/bootstrap.md says a key is
// "never committed, never pasted into a chat", and a script that echoed one would
// put it in a terminal scrollback and a CI log the first time anybody piped it.
//
//   CAPSID_OPERATOR_KEY=... node scripts/mint-agents.mjs                    # dry run, all six
//   CAPSID_OPERATOR_KEY=... node scripts/mint-agents.mjs --apply
//   CAPSID_OPERATOR_KEY=... node scripts/mint-agents.mjs --namespace foxing --apply
//   node scripts/mint-agents.mjs --roles                                  # print the role mint commands
//   CAPSID_OPERATOR_KEY=... node scripts/mint-agents.mjs --role auditor --apply
//
// --namespace exists because minting is not a one-time event: a project joins the
// roster after the first six were minted, or one key is lost and needs replacing,
// and re-running the whole set is not an option once the others are live. An
// existing key file is SKIPPED rather than overwritten, so the full run stays safe
// to repeat, but that skip is a floor and not a plan.
//
// --namespace TAKES ANY NAMESPACE REGISTERED IN CAPSID, not just a roster one.
// AGENTS below is derived from the improve roster, which is the five projects the
// loop proposes changes to; that is a smaller set than the namespaces that exist.
// A namespace can own a repo and a job queue without ever joining the roster, and
// `claude-skills` is the first that does. For one of those the script asks the
// `namespaces` tool whether it is registered and synthesizes a driver of exactly
// the shape above. Registration is the authority, so a typo still refuses.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ORIGIN_DEFAULT = "https://capsid.dustin-edwards.workers.dev";

// The six of docs/bootstrap.md. Drivers carry NO flags: a driver opens pull
// requests and a human merges them, and can_merge is how that stops being true.
export const AGENTS = [
  { name: "capsid-driver",        kind: "driver", namespaces: ["capsid"],        grants: ["read", "write"] },
  { name: "dustinedwards-driver", kind: "driver", namespaces: ["dustinedwards"], grants: ["read", "write"] },
  { name: "foxhound-driver",      kind: "driver", namespaces: ["foxhound"],      grants: ["read", "write"] },
  { name: "foxing-driver",        kind: "driver", namespaces: ["foxing"],        grants: ["read", "write"] },
  { name: "germomics-driver",     kind: "driver", namespaces: ["germomics"],     grants: ["read", "write"] },
  { name: "seat",                 kind: "seat",   namespaces: ["*"],             grants: ["read", "write"], flags: { can_merge: true } },
];

// ---- named roles, 2026-09-12 ---------------------------------------------------
//
// AGENTS above is the per-namespace bootstrap: one driver per project plus the seat.
// ROLES is a different thing and is kept in a different list for that reason. A role
// is not selected by namespace, it is asked for by name, and three of the four are
// scoped to every namespace, so folding them into AGENTS would make
// `--namespace dustinedwards` mint a credential holding can_merge.
//
// THE RULE THE LIST IS BUILT ON: a role is ONE capability. Each entry below holds at
// most one blast-radius flag, and test/roles.test.ts fails the build on a second,
// because a role that accumulates flags is a driver wearing a different name.
export const ROLES = [
  {
    name: "auditor",
    kind: "session",
    namespaces: ["*"],
    repos: ["*"],
    grants: ["read"],
    what: "reads every namespace and every repo, writes nothing anywhere. Intended for an outside model doing a cold audit.",
  },
  {
    name: "reviewer",
    kind: "session",
    namespaces: ["*"],
    repos: ["*"],
    grants: ["read", "write"],
    // The write grant is unavoidable: a comment goes through manage_pr, which is a
    // write tool. What keeps that from being a general write is the pair below. The
    // tools axis is narrowed to manage_pr and then to its comment action, and the
    // only flag held is can_comment_pr, so merge and close are refused twice over.
    tools: ["manage_pr", "manage_pr.comment"],
    flags: { can_comment_pr: true },
    what: "reads everything and may post a comment on a pull request. It cannot merge, close, or write a file.",
  },
  {
    name: "watcher",
    kind: "cron",
    namespaces: ["*"],
    repos: ["*"],
    grants: ["read", "write"],
    // Same shape, same reason: posting a job is a write, and `jobs.post` is what
    // stops that write from also being claim, complete, fail, block and resume.
    tools: ["jobs", "jobs.post"],
    what: "reads health, status and CI, and posts a job when it finds something wrong. It cannot claim or finish one, and it cannot fix anything.",
  },
  {
    name: "site-seat",
    kind: "seat",
    namespaces: ["dustinedwards"],
    repos: ["*"],
    grants: ["read", "write"],
    // Repos stays "*" deliberately. The namespace-to-repo mapping is already the
    // authorization boundary (README, Repo access), so naming repos here would be a
    // second list to keep in step with the first, and the one nobody updated would
    // be the one that mattered.
    flags: { can_merge: true },
    what: "merges pull requests in dustinedwards and nothing else. No direct write, no workflows, no protected paths.",
  },
];

// What an admin pastes. It names the script and the role rather than spelling the
// scopes again: a command that restated them would be a second copy of ROLES, and
// the copy in a report is the one that goes stale.
export function roleMintCommand(role) {
  return `CAPSID_OPERATOR_KEY=$CAPSID_OPERATOR_KEY node scripts/mint-agents.mjs --role ${role.name} --apply`;
}

export const keyDir = () => join(homedir(), ".capsid");
export const keyPath = (name) => join(keyDir(), `agent-${name}.key`);
export const fingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 12);

// A driver for a namespace that has no entry in AGENTS. Same shape as the five
// above, spelled once so a synthesized driver cannot drift from a listed one:
// read and write on its own namespace, and NO FLAGS, because a driver opens pull
// requests and a human merges them.
export function driverFor(namespace) {
  return { name: `${namespace}-driver`, kind: "driver", namespaces: [namespace], grants: ["read", "write"] };
}

// Selection is its own function so the test can drive it without a network or a
// home directory. An unknown namespace is REFUSED rather than silently matching
// nothing: "minted 0 agents" and "minted the one you meant" look identical in a
// terminal, and the second is what the caller believes happened.
//
// THE ROSTER IS NOT THE LIST OF NAMESPACES, and conflating the two is what this
// signature exists to stop. AGENTS is derived from the improve roster, which is
// the five projects the loop proposes changes to. A namespace can be registered
// in Capsid, hold documents, own a repo and need a driver to work its job queue
// without ever joining that roster: `claude-skills` is the first and will not be
// the last. So a namespace not in AGENTS is minted a driver on the strength of
// being REGISTERED, and `registered` is passed in rather than fetched here so
// this stays pure.
//
// Passing no `registered` keeps the old behaviour exactly: only AGENTS matches.
// That is the safe direction. An empty or missing list can never widen what mints,
// so a failed lookup refuses instead of inventing a namespace.
export function selectAgents(namespace, registered, role) {
  // THE ROLE SELECTOR IS CHECKED FIRST AND NEVER FALLS THROUGH. An unknown role must
  // refuse rather than quietly returning the whole bootstrap list, which is what
  // "minted 0 agents" and "minted six you did not ask for" look like in a terminal.
  if (role !== undefined) {
    const picked = ROLES.find((r) => r.name === role);
    if (!picked) throw new Error(`no role named '${role}'. Known roles: ${ROLES.map((r) => r.name).join(", ")}.`);
    return [picked];
  }
  if (namespace === undefined) return AGENTS;
  const picked = AGENTS.filter((a) => a.namespaces.includes(namespace));
  if (picked.length > 0) return picked;
  if (registered?.includes(namespace)) return [driverFor(namespace)];
  const known = [...new Set(AGENTS.flatMap((a) => a.namespaces))].join(", ");
  const also = registered?.length ? ` Registered in Capsid: ${[...registered].sort().join(", ")}.` : "";
  throw new Error(`no agent is scoped to '${namespace}'. Known: ${known}.${also}`);
}

export function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const i = argv.indexOf("--namespace");
  if (i !== -1 && !argv[i + 1]) throw new Error("--namespace needs a value, for example --namespace foxing.");
  const r = argv.indexOf("--role");
  if (r !== -1 && !argv[r + 1]) throw new Error(`--role needs a value, one of: ${ROLES.map((x) => x.name).join(", ")}.`);
  if (i !== -1 && r !== -1) throw new Error("--namespace and --role select different things; pass one or the other.");
  return {
    apply,
    namespace: i === -1 ? undefined : argv[i + 1],
    role: r === -1 ? undefined : argv[r + 1],
    roles: argv.includes("--roles"),
  };
}

// The `namespaces` tool answers with a bare array of rows keyed on `namespace`.
// Parsed in its own function so the test drives the real response shape rather
// than a shape this script hopes for.
export function parseNamespaces(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error(`the namespaces tool did not answer with JSON. Raw: ${text.slice(0, 300)}`);
  }
  if (!Array.isArray(rows)) throw new Error(`the namespaces tool answered with ${typeof rows}, not an array.`);
  const names = rows.map((r) => r?.namespace).filter((n) => typeof n === "string" && n.length > 0);
  // Vacuity guard. An empty list here would make every --namespace refuse, which
  // reads as "not registered" when it actually means "the shape changed".
  if (names.length === 0) throw new Error("the namespaces tool returned no namespaces; its response shape changed.");
  return names;
}

let id = 0;
async function rpc(origin, key, method, params) {
  const res = await fetch(`${origin}/ops/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  // Streamable HTTP may answer as SSE; take the last data: line either way.
  const payload = text.includes("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5).trim()
    : text;
  const body = JSON.parse(payload);
  if (body.error) throw new Error(`${method} -> ${JSON.stringify(body.error)}`);
  return body.result;
}

async function main() {
  let initialized = false;
  const { apply, namespace, role, roles } = parseArgs(process.argv.slice(2));
  const origin = process.env.CAPSID_ORIGIN ?? ORIGIN_DEFAULT;

  // --roles PRINTS AND STOPS, before the key check, because printing a command
  // needs no credential and asking for one to read a list would be theatre.
  if (roles) {
    console.log("Named roles. Each is minted by the admin, one command each:");
    console.log("");
    for (const r of ROLES) {
      console.log(`  ${r.name}: ${r.what}`);
      console.log(`    ${roleMintCommand(r)}`);
      console.log("");
    }
    return;
  }

  const key = process.env.CAPSID_OPERATOR_KEY;
  if (!key) {
    console.error("CAPSID_OPERATOR_KEY is not set. It is your write-grant operator key; this script never reads a file for it.");
    process.exit(2);
  }

  // Resolve before branching on --apply, so a dry run against a non-roster
  // namespace tells you whether it would mint rather than finding out later.
  // The network is only touched when AGENTS cannot answer, so a roster dry run
  // stays offline exactly as it was.
  let wanted;
  if (role !== undefined) {
    wanted = selectAgents(undefined, undefined, role);
  } else if (namespace !== undefined && !AGENTS.some((a) => a.namespaces.includes(namespace))) {
    await rpc(origin, key, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mint-agents", version: "1" },
    });
    initialized = true;
    const result = await rpc(origin, key, "tools/call", { name: "namespaces", arguments: {} });
    const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
    wanted = selectAgents(namespace, parseNamespaces(text));
  } else {
    wanted = selectAgents(namespace);
  }

  if (!apply) {
    console.log(`dry run. Would mint ${wanted.length} agent(s) and write keys into ${keyDir()}:`);
    for (const a of wanted) {
      const path = keyPath(a.name);
      const state = existsSync(path) ? "SKIP, file exists" : `-> ${path}`;
      console.log(`  ${a.name.padEnd(22)} ${a.kind.padEnd(7)} ns=${a.namespaces.join(",").padEnd(14)} ${state}`);
    }
    console.log("\nRe-run with --apply to mint.");
    return;
  }

  if (!initialized) {
    await rpc(origin, key, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mint-agents", version: "1" },
    });
  }

  mkdirSync(keyDir(), { recursive: true, mode: 0o700 });

  for (const a of wanted) {
    const path = keyPath(a.name);
    // Never overwrite: a second mint would leave a live credential in the table
    // with nothing on disk able to present it, and no way to tell which is which.
    if (existsSync(path)) {
      console.log(`${a.name}: SKIPPED, ${path} already exists`);
      continue;
    }
    // `what` is documentation for the reader of this file and is not a scope axis,
    // so it does not go over the wire. Sending it would have the tool reject the
    // whole mint for an unknown argument, or worse, accept and ignore it.
    const { what: _what, ...scopes } = a;
    const result = await rpc(origin, key, "tools/call", { name: "agents", arguments: { action: "mint", ...scopes } });
    const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
    let minted;
    try {
      minted = JSON.parse(text).key;
    } catch {
      throw new Error(`${a.name}: could not parse the mint response. Raw: ${text.slice(0, 300)}`);
    }
    if (!minted) throw new Error(`${a.name}: the mint response carried no key. Raw: ${text.slice(0, 300)}`);
    writeFileSync(path, minted + "\n", { mode: 0o600 });
    console.log(`${a.name}: written to ${path}  fingerprint ${fingerprint(minted)}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("mint-agents.mjs")) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
