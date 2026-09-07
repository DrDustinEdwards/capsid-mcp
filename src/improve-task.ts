// SIGNING THE NIGHTLY TASK DOCUMENT.
//
// In subscription mode the Worker writes `<ns>/improve/run-<day>.md` and stops,
// and a Claude Code session executes it with local shell, local git, five repo
// clones and a Capsid write grant. Both 2026-09-07 audits rated that the whole
// lethal trifecta (Opus 3.1 / 22.1, Grok MAJOR 8): the task document was an
// ordinary D1 row, so any write-grant key could rewrite it, and `/improve` is
// instructed to "execute the attempts exactly as the task doc describes".
//
// Two independent things now have to hold before a driver executes a task doc,
// and they fail in different directions on purpose:
//
//   1. THE SIGNATURE. The Worker HMACs the body with a key derived from
//      IMPROVE_SCORE_SECRET under its own context string, so a document the
//      Worker did not author cannot carry a valid line. This is the half that
//      survives an attacker who can also write audit rows.
//   2. THE PROVENANCE. The document's last audit actor must be `improve-loop`.
//      This is the half that survives a signing key leaking out of the Worker,
//      because a leaked key still cannot make D1 record a different actor.
//
// Neither is sufficient alone and the driver checks both. The signature covers
// the body BELOW the frontmatter block, so the block itself can carry the
// signature without signing itself.

import { hmacHex, timingSafeEqual } from "./auth";

// The context string. Different from the score-report and backup-credential
// contexts by construction, so a leak of one derived key opens nothing else.
// scripts/improve-derive-key.mjs performs the identical computation; the two are
// pinned against each other by test/improve-derive-key.test.ts.
export const TASK_KEY_CONTEXT = "capsid-improve-task:v1";

export async function deriveTaskKey(rootSecret: string): Promise<string> {
  return hmacHex(rootSecret, TASK_KEY_CONTEXT);
}

// The frontmatter key. One spelling, here, because the writer and the reader are
// in different modules and a typo would mean every doc silently unsigned.
export const TASK_SIGNATURE_FIELD = "capsid-task-signature";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/** Split a signed document into its frontmatter signature and the signed body. */
export function splitSignedTask(text: string): { signature: string | null; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { signature: null, body: text };
  const line = match[1]
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${TASK_SIGNATURE_FIELD}:`));
  if (!line) return { signature: null, body: text.slice(match[0].length) };
  return { signature: line.slice(`${TASK_SIGNATURE_FIELD}:`.length).trim(), body: text.slice(match[0].length) };
}

/** Wrap a rendered task body in the frontmatter block carrying its signature. */
export async function signTaskBody(rootSecret: string, body: string): Promise<string> {
  const key = await deriveTaskKey(rootSecret);
  const signature = await hmacHex(key, body);
  return `---\n${TASK_SIGNATURE_FIELD}: ${signature}\n---\n${body}`;
}

export type TaskVerification = { ok: true } | { ok: false; reason: string };

// VERIFY BOTH HALVES. `actor` is the document's last audit actor, which the
// caller reads from audit_log; passing null means "no audit row", which is a
// refusal rather than a pass, because an unaudited document is one nothing can
// attribute.
//
// UNCONFIGURED IS A REFUSAL, not a skip. If IMPROVE_SCORE_SECRET is unset the
// Worker cannot have signed anything, so every document is unverifiable and the
// honest answer is to refuse them all rather than to wave them through.
export async function verifyTaskDoc(
  rootSecret: string | undefined,
  stored: string,
  actor: string | null,
  expectedActor: string
): Promise<TaskVerification> {
  if (!rootSecret) {
    return { ok: false, reason: "task signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no task document can be verified. Refusing rather than executing an unverifiable plan." };
  }
  if (actor !== expectedActor) {
    return {
      ok: false,
      reason: `this task document was last written by '${actor ?? "(no audit row)"}', not '${expectedActor}'. Only the loop writes task documents; refusing to execute one something else authored.`,
    };
  }
  const { signature, body } = splitSignedTask(stored);
  if (!signature) {
    return {
      ok: false,
      reason: `this task document carries no ${TASK_SIGNATURE_FIELD} frontmatter line. The Worker signs every task document it writes, so an unsigned one was not written by the loop. Refusing to execute it.`,
    };
  }
  const key = await deriveTaskKey(rootSecret);
  const expected = await hmacHex(key, body);
  if (!timingSafeEqual(signature.toLowerCase(), expected)) {
    return {
      ok: false,
      reason: `this task document's ${TASK_SIGNATURE_FIELD} does not match its body. It was edited after the loop wrote it. Refusing to execute it.`,
    };
  }
  return { ok: true };
}
