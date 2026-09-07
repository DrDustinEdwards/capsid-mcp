// `cloudflare:test` types its `env` as `Cloudflare.Env`, which is a global the
// pool leaves for the project to declare. Declared here from the Worker's OWN Env
// interface, so a binding added to src/env.ts and not to vitest.config.ts is a
// typecheck failure rather than a runtime `undefined` in an integration test.
import type { Env as WorkerEnv } from "../src/env";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // Handed to the setup file through a binding: a setup file runs inside
      // workerd and cannot read migrations/ off the filesystem itself.
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
