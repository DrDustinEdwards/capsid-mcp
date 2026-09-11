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
//
// --namespace exists because minting is not a one-time event: a project joins the
// roster after the first six were minted, or one key is lost and needs replacing,
// and re-running the whole set is not an option once the others are live. An
// existing key file is SKIPPED rather than overwritten, so the full run stays safe
// to repeat, but that skip is a floor and not a plan.
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

export const keyDir = () => join(homedir(), ".capsid");
export const keyPath = (name) => join(keyDir(), `agent-${name}.key`);
export const fingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 12);

// Selection is its own function so the test can drive it without a network or a
// home directory. An unknown namespace is REFUSED rather than silently matching
// nothing: "minted 0 agents" and "minted the one you meant" look identical in a
// terminal, and the second is what the caller believes happened.
export function selectAgents(namespace) {
  if (namespace === undefined) return AGENTS;
  const picked = AGENTS.filter((a) => a.namespaces.includes(namespace));
  if (picked.length === 0) {
    const known = [...new Set(AGENTS.flatMap((a) => a.namespaces))].join(", ");
    throw new Error(`no agent is scoped to '${namespace}'. Known: ${known}.`);
  }
  return picked;
}

export function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const i = argv.indexOf("--namespace");
  if (i !== -1 && !argv[i + 1]) throw new Error("--namespace needs a value, for example --namespace foxing.");
  return { apply, namespace: i === -1 ? undefined : argv[i + 1] };
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
  const { apply, namespace } = parseArgs(process.argv.slice(2));
  const origin = process.env.CAPSID_ORIGIN ?? ORIGIN_DEFAULT;
  const key = process.env.CAPSID_OPERATOR_KEY;
  if (!key) {
    console.error("CAPSID_OPERATOR_KEY is not set. It is your write-grant operator key; this script never reads a file for it.");
    process.exit(2);
  }

  const wanted = selectAgents(namespace);

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

  await rpc(origin, key, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mint-agents", version: "1" },
  });

  mkdirSync(keyDir(), { recursive: true, mode: 0o700 });

  for (const a of wanted) {
    const path = keyPath(a.name);
    // Never overwrite: a second mint would leave a live credential in the table
    // with nothing on disk able to present it, and no way to tell which is which.
    if (existsSync(path)) {
      console.log(`${a.name}: SKIPPED, ${path} already exists`);
      continue;
    }
    const result = await rpc(origin, key, "tools/call", { name: "agents", arguments: { action: "mint", ...a } });
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
