// The Worker's environment contract, and the authenticated principal.
//
// These lived in src/server.ts until 2026-08-17 (quality audit 1.3). Every leaf
// module needs Env, so every leaf imported the root: github.ts, backup.ts and
// routes.ts all did `import type { Env } from "./server"` while server.ts
// imports github.ts at run time. The runtime graph was never cyclic because the
// imports were type-only and erased, but the TYPE graph was, and the practical
// cost was that the environment contract could not be read without opening the
// largest file in the repo.
//
// Nothing here is behaviour. It is the shape of the bindings wrangler injects plus
// the props an admitted OAuth session carries, and it belongs in a leaf that
// everything can depend on.

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  APP_KV: KVNamespace;
  MEDIA: R2Bucket;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  OPERATOR_KEY_HASH: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  ADMIN_GITHUB_LOGIN: string;
  // GitHub App for repo fallthrough (read and write). The private key is a Worker
  // secret; the client id is a plain var. There is deliberately no pinned
  // installation id: it is resolved per owner and repo (see src/github.ts).
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  // Deploy provenance, stamped by scripts/deploy.mjs at deploy time (--var),
  // not committed. Absent when deployed by bare wrangler.
  BUILD_SHA?: string;
  BUILD_DIRTY?: string;
  BUILT_AT?: string;
  // THE HOLDOUT BUCKET. A SECOND R2 bucket, not a prefix in MEDIA, and the
  // distinction is the whole security property: attempt code holds MEDIA and
  // would physically be able to read a prefix inside it, whatever a source scan
  // said. A separate binding can be withheld structurally.
  //
  // Exactly two modules may name it: this one, which declares it, and
  // src/improve-scorer.ts, which uses it. test/improve-holdout.test.ts fails if a
  // third appears, and the exemption for this file is PINNED to the two lines
  // below rather than granted by filename, so a later field here cannot quietly
  // widen it.
  HOLDOUT: R2Bucket;
  // Anthropic API key, used only in improve_mode "api". Absent in "subscription"
  // and "off", where nothing calls a model, so it is optional and the api-mode
  // entry point refuses by name when it is missing rather than failing at the
  // fetch.
  ANTHROPIC_API_KEY?: string;
  // The root secret the per-namespace score-report HMAC keys are derived from.
  // One Worker secret, N repo secrets: see deriveScoreKey in src/improve-scorer.ts
  // for why the repos never hold this value itself.
  IMPROVE_SCORE_SECRET?: string;
}

// THE ATTEMPT-SIDE ENVIRONMENT: everything except the holdout bucket.
//
// This is the type-level half of the isolation. src/improve-attempt.ts takes
// AttemptEnv, so the binding is not merely unused there, it is not present in the
// value's type at all and a `.HOLDOUT` reference does not compile. The other two
// halves are the separate bucket (infrastructure) and the source guard (a scan),
// and all three are needed: a type can be cast away, a scan can be evaded by an
// alias, and a shared bucket defeats both.
export type AttemptEnv = Omit<Env, "HOLDOUT">;

export interface Props extends Record<string, unknown> {
  id: number;
  login: string;
  name: string | null;
}
