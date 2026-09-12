import type { Env } from "./env";
import { verifySignedBody } from "./improve-task";

// ---- pre-approved gates -------------------------------------------------------
//
// WHICH BLOCKED COMMANDS THE SEAT MAY APPROVE WITHOUT ASKING THE HUMAN. A driver that
// reaches a push, a migration or a pull request stops and blocks with the exact
// command. Every one of those then waited on a person, including the ones whose
// consequence is bounded and reversible.
//
// This is the list of the bounded ones, and the reasoning runs the other way from the
// merge policy: the merge policy says what the WORKER may do alone, and this says what
// the SEAT may approve alone. The seat is still a caller with a write grant; what it
// gains is the ability to send a job back through `resume` without a human in the
// loop, and only for a command that matches a class written down and signed.
//
// THE DENIALS ARE CHECKED FIRST AND THEY ARE NOT THE COMPLEMENT OF THE CLASSES. A
// command that both looks like a branch push and carries --force must never match
// push_branch, so the deny list runs before any class is tried, over the whole command
// string.
export const GATE_POLICY_PATH = "policy/gates.md";
const POLICY_NAMESPACE = "capsid";

export const GATE_CLASSES = ["additive_migration", "push_branch", "open_pr"] as const;
export type GateClass = (typeof GATE_CLASSES)[number];

// What never matches a class, whatever else the command looks like. Each entry names
// the consequence that keeps it off the list rather than the spelling it matches.
const NEVER: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(wrangler|npx\s+wrangler)\s+secret\b/i, why: "it sets or deletes a secret" },
  { pattern: /\bgh\s+secret\b/i, why: "it sets or deletes a repository secret" },
  { pattern: /\bsecret\s+(put|delete|bulk)\b/i, why: "it sets or deletes a secret" },
  { pattern: /\brevoke\b/i, why: "it revokes a credential" },
  { pattern: /--force\b|--force-with-lease\b|(^|\s)-f(\s|$)/i, why: "it force-pushes, which rewrites history somebody else may hold" },
  { pattern: /\bpush\s+[^\n]*\+refs\//i, why: "it force-updates a ref" },
  { pattern: /\b(wrangler|npx\s+wrangler)\s+deploy\b/i, why: "it deploys" },
  { pattern: /\b(wrangler|npx\s+wrangler)\s+rollback\b/i, why: "it changes what is deployed" },
  { pattern: /\bwrangler\.jsonc?\b/i, why: "it edits deployment configuration" },
  { pattern: /\bimprove_mode\b|\bimprove_run\b/i, why: "it changes the loop's mode" },
  { pattern: /\bdrop\s+(table|index|column)\b/i, why: "it drops a database object" },
  { pattern: /\bdelete\s+from\b/i, why: "it deletes rows" },
  { pattern: /\btruncate\b/i, why: "it empties a table" },
  { pattern: /\brm\s+-rf?\b/i, why: "it deletes files recursively" },
  { pattern: /\bgh\s+pr\s+merge\b/i, why: "it merges a pull request, which is the human's gate" },
  { pattern: /\bgit\s+push[^\n]*\b(master|main)\b/i, why: "it pushes to a default branch" },
];

export function deniedReason(command: string): string | null {
  for (const { pattern, why } of NEVER) {
    if (pattern.test(command)) return why;
  }
  return null;
}

// The three classes. Each matches a narrow shape, because a loose matcher on this list
// is a widening nobody reviewed.
const PUSH_BRANCH = /^git\s+push\s+(-u\s+|--set-upstream\s+)?origin\s+[A-Za-z0-9._\/-]+\s*$/i;
const OPEN_PR = /^gh\s+pr\s+create\b/i;
const MIGRATION = /\bd1\s+execute\s+\S+[^\n]*?--file[= ]\s*(\S+)/i;

export type GateMatch =
  | { klass: GateClass; migrationPath?: string }
  | { refused: string };

/** Which class a blocked command falls into, or why it falls into none. */
export function classifyCommand(command: string): GateMatch {
  const trimmed = command.trim();
  if (!trimmed) return { refused: "the blocked job records no command, so there is nothing to match against the policy." };
  const denied = deniedReason(trimmed);
  if (denied) return { refused: `this command is on the policy's never list because ${denied}. It waits for the human.` };

  const migration = MIGRATION.exec(trimmed);
  if (migration) {
    const path = migration[1].replace(/^["']|["']$/g, "");
    if (!/(^|\/)migrations\//i.test(path)) {
      return { refused: `${path} is not under migrations/, so it is not a migration this policy covers.` };
    }
    return { klass: "additive_migration", migrationPath: path };
  }
  if (PUSH_BRANCH.test(trimmed)) return { klass: "push_branch" };
  if (OPEN_PR.test(trimmed)) return { klass: "open_pr" };
  return { refused: "this command matches no pre-approved class, so it waits for the human." };
}

// ---- is the migration additive ------------------------------------------------
//
// PARSED, NOT PATTERN-MATCHED ON THE WHOLE FILE. A file containing one additive
// statement and one DROP would pass a test that only asked whether an additive
// statement was present. Every statement is checked, and anything not recognised is a
// refusal rather than a pass, so a statement form this parser has never seen waits for
// the human instead of being waved through.
const ADDITIVE: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /^create\s+table\s+if\s+not\s+exists\b/i, what: "CREATE TABLE IF NOT EXISTS" },
  { pattern: /^alter\s+table\s+\S+\s+add\s+(column\b)?/i, what: "ALTER TABLE ADD COLUMN" },
  { pattern: /^create\s+(unique\s+)?index\s+(if\s+not\s+exists\s+)?/i, what: "CREATE INDEX" },
];

export function splitStatements(sql: string): string[] {
  // Comments first, so a DROP inside a comment is not read as a statement and a
  // semicolon inside one does not split.
  const withoutComments = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdditiveMigration(sql: string): { ok: true; statements: string[] } | { ok: false; reason: string } {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { ok: false, reason: "the migration file contains no statements." };
  const kinds: string[] = [];
  for (const statement of statements) {
    const match = ADDITIVE.find(({ pattern }) => pattern.test(statement));
    if (!match) {
      return {
        ok: false,
        reason: `the migration contains a statement this policy does not call additive: "${statement.slice(0, 80)}". Only CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN and CREATE INDEX are pre-approved.`,
      };
    }
    kinds.push(match.what);
  }
  return { ok: true, statements: kinds };
}

// ---- the policy document ------------------------------------------------------

export interface GatePolicy {
  version: string;
  enabled: boolean;
  classes: string[];
}

function field(body: string, name: string): string | null {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(`- ${name}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

const CLASS_ITEM = /^- `([a-z_]+)`/;

export function parseGatePolicy(body: string): { policy: GatePolicy } | { error: string } {
  const version = field(body, "version");
  if (!version) return { error: "the gate policy names no version, so an approval against it cannot be traced to what it allowed." };
  const enabled = field(body, "enabled");
  if (enabled === null) return { error: "the gate policy does not say whether it is enabled." };
  const classes: string[] = [];
  for (const line of body.split("\n")) {
    const match = CLASS_ITEM.exec(line.trim());
    if (match) classes.push(match[1]);
  }
  return { policy: { version, enabled: enabled.toLowerCase() === "true", classes } };
}

export async function loadGatePolicy(env: Env): Promise<{ policy: GatePolicy } | { error: string }> {
  const row = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(POLICY_NAMESPACE, GATE_POLICY_PATH)
    .first<{ body: string | null }>();
  if (!row) return { error: `no gate policy at ${POLICY_NAMESPACE}/${GATE_POLICY_PATH}, so nothing is pre-approved.` };
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, row.body ?? "", "gate policy");
  if (!verdict.ok) return { error: verdict.reason };
  const parsed = parseGatePolicy(row.body ?? "");
  if ("error" in parsed) return parsed;
  const missing = GATE_CLASSES.filter((c) => !parsed.policy.classes.includes(c));
  if (missing.length > 0) {
    return {
      error: `the gate policy does not name ${missing.join(", ")}, which this Worker would approve. Refusing rather than approving against a policy that describes less than the code does.`,
    };
  }
  return parsed;
}

// ---- the whole decision -------------------------------------------------------

export type ApprovalVerdict =
  | { approved: true; klass: GateClass; detail: string; policyVersion: string }
  | { approved: false; reason: string };

/**
 * Whether the seat may send this blocked command back in on the policy alone.
 * `readMigration` is passed in so the caller owns the repo read and this stays
 * testable without a GitHub fake.
 */
export async function approveByPolicy(
  env: Env,
  requestedVersion: string,
  command: string | null,
  readMigration: (path: string) => Promise<string | null>
): Promise<ApprovalVerdict> {
  const loaded = await loadGatePolicy(env);
  if ("error" in loaded) return { approved: false, reason: loaded.error };
  const policy = loaded.policy;
  if (!policy.enabled) {
    return { approved: false, reason: `gate policy ${policy.version} is present and disabled, so nothing is pre-approved.` };
  }
  if (requestedVersion !== policy.version) {
    return {
      approved: false,
      reason: `this approval names policy version '${requestedVersion}' and the stored policy is version '${policy.version}'. Re-read the policy before approving against it.`,
    };
  }
  if (!command) {
    return { approved: false, reason: "this blocked job records no command, so there is nothing for the policy to match." };
  }

  const match = classifyCommand(command);
  if ("refused" in match) return { approved: false, reason: match.refused };

  if (match.klass === "additive_migration") {
    const sql = await readMigration(match.migrationPath as string);
    if (sql === null) {
      return { approved: false, reason: `${match.migrationPath} could not be read, so its statements could not be checked. A migration nobody parsed is not pre-approved.` };
    }
    const additive = isAdditiveMigration(sql);
    if (!additive.ok) return { approved: false, reason: additive.reason };
    return {
      approved: true,
      klass: match.klass,
      detail: `${match.migrationPath}: ${additive.statements.join(", ")}`,
      policyVersion: policy.version,
    };
  }

  return { approved: true, klass: match.klass, detail: command.trim(), policyVersion: policy.version };
}
