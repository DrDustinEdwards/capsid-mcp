// THE BACKUP FRESHNESS CHECK, separated from the gate so a test can drive it, for
// the same reason scripts/canary-lib.mjs and scripts/reap-lib.mjs exist:
// verify-live.mjs is a program that runs on import.
//
// WHY THIS IS A GATE AND NOT A FIELD (residual 7). /health has reported
// `backup.last_ok` and an age since 2026-09-07, and warns past 26 hours. NOTHING
// READ IT. A field nobody reads is not monitoring, it is a field: the backup cron
// could fail every night and the only signal would be a JSON key nobody fetches,
// found the next time someone needed a dump. Measured on live during the
// 2026-09-07 audit, `backup:last-ok` was null and no gate said anything.
//
// TWENTY-SIX HOURS is the daily cron plus a two-hour grace, the same number
// src/health.ts uses, so a single late run does not fail the gate and a genuinely
// missed day does.
//
// ASSERTED ON SCHEDULED RUNS ONLY, and SKIPPED LOUDLY otherwise. A push runs
// minutes after a deploy and says nothing about whether last night's backup ran,
// so failing a deploy on it would be noise attached to the wrong event. The
// six-hourly schedule is the run whose entire purpose is time-to-detect, and it
// bounds this at six hours. A skip is REPORTED as a skip, never as a pass.
//
// THE AGE IS COMPUTED HERE, from last_ok, rather than taken from the response's
// own age_hours. Same reason the holdout pass rate is recomputed from the
// manifest: a number the thing under test hands you is not a measurement of it.
// The reported value is cross-checked and a large disagreement is itself a
// finding, because it means the Worker's clock and the runner's disagree.

export const BACKUP_STALE_HOURS = 26;

// A disagreement larger than this between the age we compute and the age the
// Worker reports means the two clocks are not the same clock. Well above any
// plausible request latency.
const CLOCK_SKEW_TOLERANCE_HOURS = 1;

/**
 * @param {unknown} health the parsed /health body
 * @param {{ assert: boolean, now?: number, maxHours?: number }} opts
 * @returns {{ outcome: "fresh"|"stale"|"unknown"|"skipped", passed: boolean, detail: string }}
 */
export function checkBackupFreshness(health, opts) {
  const maxHours = opts.maxHours ?? BACKUP_STALE_HOURS;
  const backup = health && typeof health === "object" ? health.backup : null;
  const lastOk = backup && typeof backup === "object" ? backup.last_ok : null;

  if (!opts.assert) {
    const seen = typeof lastOk === "string" ? lastOk : "(none)";
    return {
      outcome: "skipped",
      passed: true,
      detail: `SKIPPED: freshness is asserted on scheduled runs only (last_ok=${seen}). This run asserts nothing about it.`,
    };
  }

  if (typeof lastOk !== "string" || lastOk.length === 0) {
    // FAIL CLOSED. No stamp means no backup has completed cleanly, which is
    // exactly the condition this gate exists to catch, not a reason to skip.
    return {
      outcome: "unknown",
      passed: false,
      detail: `no backup:last-ok is recorded, so no clean backup has completed. /health reported backup=${JSON.stringify(backup)}`,
    };
  }

  const stamped = Date.parse(lastOk);
  if (Number.isNaN(stamped)) {
    return { outcome: "unknown", passed: false, detail: `backup.last_ok is not a parseable timestamp: ${JSON.stringify(lastOk)}` };
  }

  const now = opts.now ?? Date.now();
  const ageHours = Math.round(((now - stamped) / 3_600_000) * 10) / 10;
  const reported = typeof backup.age_hours === "number" ? backup.age_hours : null;
  const skew =
    reported === null ? "" : ` (worker reported ${reported}h${Math.abs(reported - ageHours) > CLOCK_SKEW_TOLERANCE_HOURS ? ", DISAGREEING with this runner's clock" : ""})`;

  if (ageHours > maxHours) {
    return {
      outcome: "stale",
      passed: false,
      detail: `the last clean backup was ${ageHours}h ago, over the ${maxHours}h threshold${skew}. last_ok=${lastOk}`,
    };
  }
  return { outcome: "fresh", passed: true, detail: `last clean backup ${ageHours}h ago${skew}, under the ${maxHours}h threshold` };
}
