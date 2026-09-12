// Install, remove or run the nightly /improve work driver, one Windows Task
// Scheduler task per project folder.
//
//   node scripts/schedule-drivers.mjs --list
//   node scripts/schedule-drivers.mjs --install                      # dry run, every namespace
//   node scripts/schedule-drivers.mjs --install --namespace capsid --apply
//   node scripts/schedule-drivers.mjs --remove --namespace capsid --apply
//   node scripts/schedule-drivers.mjs --run --namespace capsid       # what the task invokes
//
// WHY A LOCAL TASK AND NOT A CLOUD ROUTINE. Ruled 2026-09-12 after measuring the
// routine API (capsid/autonomy-part3-routines.md). A Claude Code cloud routine can
// only attach claude.ai connectors, and the registered Capsid connector points at
// /mcp, the OAuth admin path. A nightly routine would therefore run the whole queue
// as the admin, with every namespace and every blast-radius flag, which is the wide
// credential the per-namespace driver agents were minted to replace. There is also
// no verified way to hand a routine a secret. On this machine the per-namespace key
// files already exist and the credential model already holds, so the scheduler runs
// here and each task reaches Capsid as exactly one driver.
//
// OFF BY DEFAULT, TWICE OVER. Nothing is created without --apply, and an installed
// task is created DISABLED. Enabling it is a separate, deliberate act:
//
//   schtasks /Change /TN "<task name>" /ENABLE
//
// A scheduler that armed itself on install would be a nightly unattended agent
// nobody decided to switch on.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ORIGIN_DEFAULT = "https://capsid.dustin-edwards.workers.dev";

// The namespace to repo-folder map, the same one .claude/commands/improve.md carries.
// A namespace with no folder here is not schedulable from this machine.
const FOLDERS = {
  capsid: "C:\\Users\\email\\dev\\capsid-mcp",
  dustinedwards: "C:\\Users\\email\\dev\\dustinedwards-info",
  foxhound: "C:\\Users\\email\\dev\\foxhound",
  foxing: "C:\\Users\\email\\dev\\foxing",
  germomics: "C:\\Users\\email\\dev\\germomics",
};

// 04:00 America/Chicago. schtasks takes a LOCAL wall-clock time and the machine is
// already on America/Chicago, so this is 04:00 all year and the task does not drift
// across the daylight-saving switch the way a UTC cron expression would. That is the
// one thing a local scheduler does better than the Worker's own cron, which needs two
// expressions and chicagoHour() to pin the same instant.
const START_TIME = "04:00";

export const taskName = (ns) => `Capsid improve driver (${ns})`;
export const keyPath = (ns) => join(homedir(), ".capsid", `agent-${ns}-driver.key`);

function parseArgs(argv) {
  const out = { mode: null, namespace: undefined, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--install" || arg === "--remove" || arg === "--run" || arg === "--list") out.mode = arg.slice(2);
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--namespace") out.namespace = argv[++i];
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (!out.mode) throw new Error("one of --install, --remove, --run or --list is required.");
  if (out.mode === "run" && !out.namespace) throw new Error("--run needs --namespace.");
  if (out.namespace !== undefined && !Object.hasOwn(FOLDERS, out.namespace)) {
    throw new Error(`'${out.namespace}' has no repo folder on this machine. Known: ${Object.keys(FOLDERS).join(", ")}`);
  }
  return out;
}

export function selected(namespace) {
  return namespace ? [namespace] : Object.keys(FOLDERS);
}

function schtasks(args) {
  const res = spawnSync("schtasks", args, { encoding: "utf8" });
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

export function taskExists(ns) {
  return schtasks(["/Query", "/TN", taskName(ns)]).code === 0;
}

// ---- the log the nightly run leaves behind --------------------------------------

let rpcId = 0;
async function rpc(origin, key, method, params) {
  const res = await fetch(`${origin}/ops/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  const payload = text.includes("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5).trim()
    : text;
  const body = JSON.parse(payload);
  if (body.error) throw new Error(`${method} -> ${JSON.stringify(body.error)}`);
  return body.result;
}

// The Chicago day, because the run is scheduled by Chicago wall clock and a log named
// by the UTC day would file a 04:00 run under the previous date for half the year.
export function chicagoDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export const logPath = (day) => `jobs/nightly-${day}.md`;

// Bounded, because a driver session's transcript is unbounded and this lands in a
// document somebody reads. The tail is kept rather than the head: what a run ended
// with is what says whether it finished, blocked, or died.
export const LOG_BUDGET = 24_000;

export function renderLog(ns, { exitCode, output, started, finished }) {
  const trimmed =
    output.length > LOG_BUDGET
      ? `[${output.length - LOG_BUDGET} earlier characters omitted]\n\n${output.slice(-LOG_BUDGET)}`
      : output;
  const verdict = exitCode === 0 ? "finished" : `exited ${exitCode}`;
  return [
    `# Nightly driver run, ${ns}`,
    "",
    `Written by scripts/schedule-drivers.mjs on the machine that holds this namespace's driver key.`,
    "",
    `- started: ${started}`,
    `- finished: ${finished}`,
    `- claude exit code: ${exitCode} (${verdict})`,
    "",
    "## Output",
    "",
    "```",
    trimmed,
    "```",
    "",
  ].join("\n");
}

async function postLog(ns, origin, key, body, day) {
  await rpc(origin, key, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "schedule-drivers", version: "1" },
  });
  await fetch(`${origin}/ops/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
  return rpc(origin, key, "tools/call", {
    name: "write",
    arguments: {
      namespace: ns,
      path: logPath(day),
      title: `Nightly driver run, ${ns}, ${day}`,
      type: "reference",
      tags: "jobs,nightly",
      body,
      confirm: true,
    },
  });
}

// ---- run ------------------------------------------------------------------------

async function runOne(ns) {
  const folder = FOLDERS[ns];
  const key = process.env.CAPSID_DRIVER_KEY ?? readKey(ns);
  const started = new Date().toISOString();
  // The driver session. Its own credential comes from the project-scoped MCP server
  // configured in that folder, not from this process: the key read above is only for
  // posting the log afterwards, so a failed run still records something.
  const res = spawnSync("claude", ["-p", "/improve work"], {
    cwd: folder,
    encoding: "utf8",
    shell: true,
    timeout: 4 * 60 * 60 * 1000,
  });
  const finished = new Date().toISOString();
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() || "(no output)";
  const exitCode = res.status ?? 1;

  const day = chicagoDay(new Date());
  const body = renderLog(ns, { exitCode, output, started, finished });
  if (!key) {
    console.error(`no driver key for ${ns} at ${keyPath(ns)}; the run finished but its log was not posted.`);
    console.log(body);
    return exitCode;
  }
  try {
    await postLog(ns, process.env.CAPSID_ORIGIN ?? ORIGIN_DEFAULT, key, body, day);
    console.log(`posted ${ns}/${logPath(day)}`);
  } catch (err) {
    // A log that could not be posted does not change what the run did. It goes to
    // stdout, which Task Scheduler keeps, rather than being lost.
    console.error(`could not post the run log for ${ns}: ${err.message}`);
    console.log(body);
  }
  return exitCode;
}

// The key is read to POST the run log and for nothing else; the driver session gets
// its own credential from the project-scoped MCP server in that folder. It is never
// printed, on the same rule as scripts/mint-agents.mjs.
function readKey(ns) {
  const path = keyPath(ns);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim();
}

// ---- install and remove ---------------------------------------------------------

// The task runs THIS script in --run mode. A task that invoked `claude` directly
// could not post a log for a session that died, which is the run whose log matters
// most.
function installCommand(ns) {
  const script = join(process.cwd(), "scripts", "schedule-drivers.mjs");
  return `node "${script}" --run --namespace ${ns}`;
}

function install(ns, apply) {
  const exists = taskExists(ns);
  const command = installCommand(ns);
  if (!apply) {
    return `${exists ? "REPLACE" : "CREATE "} ${taskName(ns)}  daily ${START_TIME}  ${command}`;
  }
  const created = schtasks([
    "/Create",
    "/TN", taskName(ns),
    "/TR", command,
    "/SC", "DAILY",
    "/ST", START_TIME,
    "/F",
  ]);
  if (created.code !== 0) return `FAILED  ${taskName(ns)}: ${created.out}`;
  // CREATED DISABLED. See the header: install is not the same act as switching on a
  // nightly unattended agent, and conflating them is how one ends up running because
  // somebody ran a setup script.
  const disabled = schtasks(["/Change", "/TN", taskName(ns), "/DISABLE"]);
  if (disabled.code !== 0) return `CREATED ${taskName(ns)} but could NOT disable it: ${disabled.out}`;
  return `created ${taskName(ns)}, DISABLED. Enable with: schtasks /Change /TN "${taskName(ns)}" /ENABLE`;
}

function remove(ns, apply) {
  if (!taskExists(ns)) return `absent  ${taskName(ns)}`;
  if (!apply) return `DELETE  ${taskName(ns)}`;
  const res = schtasks(["/Delete", "/TN", taskName(ns), "/F"]);
  return res.code === 0 ? `deleted ${taskName(ns)}` : `FAILED  ${taskName(ns)}: ${res.out}`;
}

function list() {
  for (const ns of Object.keys(FOLDERS)) {
    const state = taskExists(ns) ? "installed" : "not installed";
    const keyState = existsSync(keyPath(ns)) ? "key present" : "NO KEY FILE";
    console.log(`  ${ns.padEnd(16)} ${state.padEnd(14)} ${keyState}`);
  }
}

async function main() {
  const { mode, namespace, apply } = parseArgs(process.argv.slice(2));
  if (mode === "list") return list();
  if (mode === "run") process.exit(await runOne(namespace));

  const targets = selected(namespace);
  for (const ns of targets) {
    if (!existsSync(keyPath(ns))) {
      console.log(`SKIP    ${ns}: no key file at ${keyPath(ns)}. Mint it before scheduling a driver for it.`);
      continue;
    }
    console.log(`  ${mode === "install" ? install(ns, apply) : remove(ns, apply)}`);
  }
  if (!apply) console.log("\nDry run. Re-run with --apply to change anything.");
}

// Only when executed, so the pure helpers above are importable by the test suite.
if (process.argv[1] && process.argv[1].endsWith("schedule-drivers.mjs")) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}
