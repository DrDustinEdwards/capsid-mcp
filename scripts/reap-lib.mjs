// The reap DECISION, separated from the CLI so it can be driven by a test.
//
// WHY THIS EXISTS AS ITS OWN MODULE. reap-probe-clients.mjs is a program: it reads
// argv and the environment, then exits. Importing it to test it would run it. The
// decision it makes is the part worth testing, so the decision lives here, takes a
// fetch, and returns a verdict instead of exiting.
//
// WHY THE READ COMES FIRST (2026-08-17). KV DELETE is IDEMPOTENT: deleting a key
// that was never there returns the same 200 as deleting one that was, and the
// read-back afterwards returns 404 either way. So the old sequence, DELETE then
// confirm-404, could not distinguish these three states:
//
//   1. the key existed and this run removed it            (the normal case)
//   2. the key had already vanished on its own            (a data-loss signal)
//   3. this script is pointed at the wrong namespace id   (a config error)
//
// and it reported all three as "deleted and confirmed gone". That is not a
// cosmetic difference. On 2026-08-17 an OAuth client record disappeared from
// OAUTH_KV with no request in the window that could account for it, and the
// investigation ruled out five hypotheses without finding a cause. This reaper ran
// against that same keyspace throughout and reported success every time, because
// success was the only thing it could report. A verification step whose passing
// result is unconditional is not a verification step.
//
// So: read, then delete, then read back. The pre-read is what makes the outcome
// mean something.

export const REAP_OUTCOMES = /** @type {const} */ ([
  "deleted",
  "already-absent",
  "unreadable",
  "delete-failed",
  "still-present",
]);

/**
 * @param {{ fetchImpl: typeof fetch, base: string, key: string, auth: Record<string,string> }} opts
 * @returns {Promise<{ outcome: string, status?: number, detail?: string }>}
 */
export async function reapProbeClient({ fetchImpl, base, key, auth }) {
  const url = `${base}/values/${encodeURIComponent(key)}`;

  // 1. READ FIRST. This is the only step that can tell "removed" from "was never
  // there", and it runs before anything is changed.
  const before = await fetchImpl(url, { headers: auth });

  // A transport or auth failure says nothing about the key. Reported as its own
  // outcome so a broken token can never be read as data loss, which is the
  // distinction the live-gate canary needs too.
  if (!before.ok && before.status !== 404) {
    return {
      outcome: "unreadable",
      status: before.status,
      detail: (await before.text().catch(() => "")).slice(0, 300),
    };
  }

  const existed = before.status !== 404;

  // 2. Delete. Issued even when the pre-read came back 404, deliberately: the
  // delete is idempotent so it costs nothing, and if that 404 was itself a blip
  // rather than the truth, skipping the delete would leak the key. Cleanup is the
  // job; reporting is the other job; doing one badly to do the other is not a
  // trade worth making.
  const del = await fetchImpl(url, { method: "DELETE", headers: auth });
  if (!del.ok) {
    return {
      outcome: "delete-failed",
      status: del.status,
      detail: (await del.text().catch(() => "")).slice(0, 300),
    };
  }

  // 3. Read back. A 200 from the API is what the API returns; it is not evidence
  // the key is gone.
  const after = await fetchImpl(url, { headers: auth });
  if (after.status !== 404) return { outcome: "still-present", status: after.status };

  return existed ? { outcome: "deleted" } : { outcome: "already-absent" };
}

// How each outcome is reported, and whether it fails the job.
//
// `already-absent` FAILS on purpose. The key it names was written by gate 2 of the
// same run, minutes earlier, and it carries a 90 day TTL, so there is no ordinary
// reason for it to be missing. The two explanations are a vanished record or a
// reaper pointed at the wrong keyspace, and both are things to be told about
// loudly rather than to find later in a log nobody reads.
export function reportFor(outcome, key) {
  switch (outcome) {
    case "deleted":
      return { ok: true, message: `reap: read ${key}, deleted it, and confirmed it is gone (read-back 404)` };
    case "already-absent":
      return {
        ok: false,
        message:
          `reap: ANOMALY. ${key} was ALREADY ABSENT before this delete. Gate 2 registered it minutes ago and it carries a 90 day TTL, ` +
          `so this is either the vanished-client-record anomaly of 2026-08-17 recurring, or this script is pointed at the wrong KV namespace. ` +
          `The delete was issued anyway and the key is gone; what is NOT true is that this run removed a record it had created.`,
      };
    case "unreadable":
      return {
        ok: false,
        message: `reap: could not READ ${key}, so nothing was deleted and nothing is claimed about whether it exists. This is a KV or credential failure, NOT evidence of data loss.`,
      };
    case "delete-failed":
      return { ok: false, message: `reap: DELETE ${key} failed. The key may still exist.` };
    case "still-present":
      return { ok: false, message: `reap: deleted ${key} but it still reads back. Not treating that as done.` };
    default:
      return { ok: false, message: `reap: unknown outcome ${JSON.stringify(outcome)}` };
  }
}
