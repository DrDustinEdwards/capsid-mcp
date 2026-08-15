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
}

export interface Props extends Record<string, unknown> {
  id: number;
  login: string;
  name: string | null;
}
