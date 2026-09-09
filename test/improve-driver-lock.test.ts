import assert from "node:assert/strict";
import { test } from "node:test";
import { improveControl, improveStatus } from "../src/improve-run.ts";
import { driverKey, DRIVER_LEASE_TTL_SECONDS, PROTECTED_PATH_PATTERNS, protectedHits } from "../src/improve-schema.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// THE SUBSCRIPTION-MODE DRIVER LOCK AND PATH GUARD (residuals 9 and 10).
//
// Both residuals are one hole seen from two sides: subscription mode runs on a
// laptop with five repo clones and local credentials, and none of the Worker's
// safety machinery reaches it. The partial unique index that stops two API-mode
// runs does not apply, because subscription mode creates no run row; and the
// deterministic path guard runs inside the Worker's attempt path, which the
// driver never enters.
//
//   the lock   improve:driver:<ns> in APP_KV, six-hour TTL, claimed before any
//              work and released at the end. KV has no compare-and-set, so this
//              is best-effort exactly like the backup lease, and it says so
//              rather than being described as stronger than it is.
//   the guard  improve_status now SERVES the pattern list, so the driver applies
//              the rules the Worker holds instead of a copy in prose that drifts
//              the first time a pattern is added here.

function harness(seed: Record<string, string> = {}) {
  const kv = fakeKv({ seed });
  const d1 = fakeD1();
  return { env: fakeEnv({ APP_KV: kv.kv, DB: d1.db }), kv, d1 };
}

const audited = (d1: ReturnType<typeof fakeD1>) => d1.batches.some((b) => b.some((s) => /INSERT INTO audit_log/.test(s)));

test("claim takes the lease for one namespace, with a six-hour TTL", async () => {
  const { env, kv, d1 } = harness();
  const r = await improveControl(env, "claim", { namespace: "capsid" });
  assert.equal(r.action, "claim");
  if (r.action !== "claim") return;
  assert.equal(r.held, true);
  assert.equal(r.namespace, "capsid");
  const put = kv.puts.find((p) => p.key === driverKey("capsid"));
  assert.ok(put, "the lease key was not written");
  assert.equal(put.ttl, DRIVER_LEASE_TTL_SECONDS);
  assert.equal(DRIVER_LEASE_TTL_SECONDS, 6 * 60 * 60);
  assert.ok(audited(d1), "the claim was not audited");
});

test("a second claim is REFUSED while the first holds it, and overwrites nothing", async () => {
  const { env, kv } = harness();
  await improveControl(env, "claim", { namespace: "capsid" });
  const first = kv.store.get(driverKey("capsid"));
  const second = await improveControl(env, "claim", { namespace: "capsid" });
  assert.equal(second.action, "claim");
  if (second.action !== "claim") return;
  assert.equal(second.held, false, "two drivers both believe they hold the lease");
  assert.match(second.reason ?? "", /held/i);
  assert.equal(kv.store.get(driverKey("capsid")), first, "the refused claim overwrote the holder's lease");
});

test("release clears it, and the next claim succeeds", async () => {
  const { env, kv } = harness();
  await improveControl(env, "claim", { namespace: "capsid" });
  const released = await improveControl(env, "claim", { namespace: "capsid", release: true });
  assert.equal(released.action, "claim");
  if (released.action !== "claim") return;
  assert.equal(released.held, false);
  assert.equal(kv.store.has(driverKey("capsid")), false);
  const again = await improveControl(env, "claim", { namespace: "capsid" });
  assert.equal(again.action === "claim" && again.held, true);
});

test("the lease is per namespace: claiming capsid leaves foxing free", async () => {
  const { env } = harness();
  await improveControl(env, "claim", { namespace: "capsid" });
  const other = await improveControl(env, "claim", { namespace: "foxing" });
  assert.equal(other.action === "claim" && other.held, true);
});

test("claim refuses a namespace that is not on the roster", async () => {
  const { env, kv } = harness();
  await assert.rejects(() => improveControl(env, "claim", { namespace: "julieedwards" }), /roster/);
  assert.equal(kv.store.size, 0);
});

test("improve_status SERVES the protected path list, so the driver cannot hold a stale copy", async () => {
  const { env } = harness();
  const status = await improveStatus(env);
  assert.ok(Array.isArray(status.protected_paths), "improve_status does not report the protected paths");
  // DERIVED IN BOTH DIRECTIONS from the source of truth: a pattern added to
  // PROTECTED_PATH_PATTERNS and not served, or served and not in the list, fails.
  assert.deepEqual(
    status.protected_paths.map((p) => p.pattern),
    PROTECTED_PATH_PATTERNS.map((p) => p.pattern.source)
  );
  assert.deepEqual(
    status.protected_paths.map((p) => p.why),
    PROTECTED_PATH_PATTERNS.map((p) => p.why)
  );
  assert.ok(status.protected_paths.length >= 20, "the served list is implausibly short");
});

test("the served patterns REBUILD to the same verdicts as the Worker's own guard", async () => {
  // The property that matters is not that the strings match, it is that a driver
  // reconstructing RegExps from them refuses exactly what the Worker refuses.
  const { env } = harness();
  const status = await improveStatus(env);
  const rebuilt = status.protected_paths.map((p) => new RegExp(p.pattern, p.flags));
  const cases = [
    "src/server.ts",
    "test/backup.test.ts",
    ".github/workflows/ci.yml",
    "package-lock.json",
    "apps/web/wrangler.jsonc.example",
    "docs/README.md",
    "src/improve-run.ts",
    "scripts/deploy.mjs",
    "CLAUDE.md",
    ".claude/settings.json",
    "app/routes/home.tsx",
  ];
  for (const path of cases) {
    const theirs = protectedHits([path]).length > 0;
    const ours = rebuilt.some((pattern) => pattern.test(path));
    assert.equal(ours, theirs, `the rebuilt list disagrees with protectedHits on ${path}`);
  }
  // NOT VACUOUS: the fixture must produce both verdicts, or "they agree" would be
  // true of a guard that refuses nothing.
  assert.ok(cases.some((p) => protectedHits([p]).length > 0));
  assert.ok(cases.some((p) => protectedHits([p]).length === 0));
});

test("the path guard the driver runs refuses exactly what the Worker refuses", async () => {
  // scripts/path-guard.mjs is what makes residual 10 deterministic rather than a
  // paragraph of prose in a command file. It takes the list improve_status served
  // and the changed paths, and exits nonzero on a hit.
  // @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately:
  // the driver runs it from a clone with no install.
  const { checkPaths } = await import("../scripts/path-guard.mjs");
  const served = PROTECTED_PATH_PATTERNS.map((p) => ({ pattern: p.pattern.source, flags: p.pattern.flags, why: p.why }));
  for (const path of ["src/server.ts", "test/x.test.ts", ".github/workflows/ci.yml", "app/root.tsx", "migrations/0006.sql"]) {
    const hits = checkPaths(served, [path]);
    assert.equal(hits.length > 0, protectedHits([path]).length > 0, `path-guard disagrees with the Worker on ${path}`);
  }
  // An empty served list is a REFUSAL, not a pass: a driver that failed to fetch
  // the list must not conclude that nothing is protected.
  assert.throws(() => checkPaths([], ["src/server.ts"]), /no protected paths/i);
  // And a hit names the path AND the reason, because the driver prints it.
  const [hit] = checkPaths(served, ["test/x.test.ts"]);
  assert.equal(hit.path, "test/x.test.ts");
  assert.match(hit.why, /test/i);
});
