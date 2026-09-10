import { hmacHex, timingSafeEqual } from "./auth";

// Distinct from the score-report and backup-credential contexts on purpose.
// scripts/improve-derive-key.mjs must match; test/improve-derive-key.test.ts pins both.
export const TASK_KEY_CONTEXT = "capsid-improve-task:v1";

export async function deriveTaskKey(rootSecret: string): Promise<string> {
  return hmacHex(rootSecret, TASK_KEY_CONTEXT);
}

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

// Two halves: HMAC of the body below the frontmatter, and last audit actor
// improve-loop. Unconfigured (no IMPROVE_SCORE_SECRET) is a refusal, not a skip.
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
