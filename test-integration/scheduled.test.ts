import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { BACKUP_CRON, IMPROVE_OPEN_CRON, IMPROVE_TICK_CRON } from "../src/index";

// THE SCHEDULED HANDLER, ALL THREE CRONS, AGAINST REAL BINDINGS.
//
// Three expressions share 09:00 UTC, and Cloudflare delivers the invocation once
// per expression, so the handler dispatches on `controller.cron` rather than on the
// clock. test/improve-cron.test.ts derives the handler's list and the config's list
// from each other; what it cannot do is RUN either of them. This does, which is how
// a cron that dispatches to a branch that throws on a real binding becomes visible.
//
// Every one of these asserts the same shape: the invocation completes, the work it
// was supposed to do is observable in a real store, and the branches it was not
// supposed to take left no trace. A cron that silently does nothing is the failure
// mode the 2026-08-09 outage was made of.

const controller = (cron: string) =>
  ({ cron, scheduledTime: Date.now(), noRetry() {} }) as unknown as ScheduledController;

async function fire(cron: string) {
  const ctx = createExecutionContext();
  await worker.scheduled?.(controller(cron), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("the three cron expressions", () => {
  it("the handler exports exactly the three the config declares", () => {
    expect([BACKUP_CRON, IMPROVE_OPEN_CRON, IMPROVE_TICK_CRON]).toEqual(["0 9 * * *", "0 8,9 * * *", "*/5 * * * *"]);
  });

  it("the backup cron writes real dumps to real R2", async () => {
    await env.DB.prepare(
      `INSERT INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'cron-fixture.md', 'A document to dump', 'body', 'note', 'published')`
    ).run();

    await fire(BACKUP_CRON);

    const listed = await env.MEDIA.list();
    expect(listed.objects.length, "the backup cron produced no objects at all").toBeGreaterThan(0);

    // The dump covers every real table, and the list is derived from migrations/ by
    // test/backup.test.ts. What that cannot check is whether SELECT * FROM <table>
    // succeeds against the real schema for each one. A dump that threw halfway
    // leaves the earlier objects behind and looks like a partial success, so the
    // assertion is on the table this fixture put a row in.
    const documentsDump = listed.objects.find((o: { key: string }) => o.key.includes("documents"));
    expect(documentsDump, `no documents dump among ${listed.objects.map((o: { key: string }) => o.key).join(", ")}`).toBeTruthy();
    const dumped = await env.MEDIA.get(documentsDump!.key);
    expect(await dumped!.text()).toContain("cron-fixture.md");
  });

  it("the improve opener runs and writes nothing while the mode is off", async () => {
    // improve_mode falls back to `off` on an unset key, which is the state a fresh
    // store is in. The opener must complete and open nothing: an unreadable KV that
    // starts writing to five repos is the failure this default exists to stop.
    await fire(IMPROVE_OPEN_CRON);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM improve_runs").first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it("the improve tick runs against real improve tables and advances nothing when there is nothing to advance", async () => {
    await fire(IMPROVE_TICK_CRON);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM improve_runs").first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it("an unrecognised cron expression does no work at all", async () => {
    // The dispatch is on the expression, so a fourth cron added to the config and
    // not to the handler must be inert rather than falling into the backup branch.
    const before = (await env.MEDIA.list()).objects.length;
    await fire("0 0 1 1 *");
    expect((await env.MEDIA.list()).objects.length).toBe(before);
  });
});

describe("the improve schema is real", () => {
  it("the jti replay cache really has a PRIMARY KEY, so a duplicate claim conflicts", async () => {
    // migrations/0004_improve_jti.sql. The unit suite proves the statement is
    // `INSERT ... ON CONFLICT DO NOTHING RETURNING`; only a real database proves
    // the conflict happens, and the whole replay defence rests on it.
    const first = await env.DB.prepare(
      "INSERT INTO improve_jti (scope, jti, seen_at) VALUES ('capsid', 'dup', datetime('now')) ON CONFLICT DO NOTHING RETURNING jti"
    ).first<{ jti: string }>();
    expect(first?.jti).toBe("dup");

    const second = await env.DB.prepare(
      "INSERT INTO improve_jti (scope, jti, seen_at) VALUES ('capsid', 'dup', datetime('now')) ON CONFLICT DO NOTHING RETURNING jti"
    ).first<{ jti: string }>();
    expect(second, "the second claim must return nothing; if it returns a row the replay cache is decorative").toBeNull();
  });

  it("the one-active-run partial unique index really refuses a second open run", async () => {
    await env.DB.prepare(
      `INSERT INTO improve_runs (id, namespace, mode, status, started, condition)
       VALUES ('r-one', 'capsid', 'subscription', 'open', datetime('now'), 'full')`
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO improve_runs (id, namespace, mode, status, started, condition)
         VALUES ('r-two', 'capsid', 'subscription', 'open', datetime('now'), 'full')`
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare("DELETE FROM improve_runs WHERE id = 'r-one'").run();
  });
});
