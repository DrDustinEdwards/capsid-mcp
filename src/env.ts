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
  // GitHub App. No pinned installation id: resolved per owner and repo.
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  // Stamped by scripts/deploy.mjs at deploy time, not committed.
  BUILD_SHA?: string;
  BUILD_DIRTY?: string;
  BUILT_AT?: string;
  // Second R2 bucket, withheld from AttemptEnv. Only this file (declaration) and
  // src/improve-scorer.ts may name it; test/improve-holdout.test.ts pins the lines.
  HOLDOUT: R2Bucket;
  // Used only in improve_mode "api".
  ANTHROPIC_API_KEY?: string;
  // Root secret the per-namespace score-report HMAC keys are derived from.
  IMPROVE_SCORE_SECRET?: string;
  // Holdout mint only; omitted from AttemptEnv; only improve-scorer.ts may name the token.
  R2_TEMP_CRED_TOKEN?: string;
  R2_TEMP_CRED_PARENT_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  // Backup mint parent, separate from the holdout parent. Omitted from AttemptEnv.
  R2_BACKUP_PARENT_ACCESS_KEY_ID?: string;
}

// Everything except the holdout bucket and the credentials that could mint read access to it.
export type AttemptEnv = Omit<Env, "HOLDOUT" | "R2_TEMP_CRED_TOKEN" | "R2_TEMP_CRED_PARENT_ACCESS_KEY_ID" | "R2_BACKUP_PARENT_ACCESS_KEY_ID">;

export interface Props extends Record<string, unknown> {
  id: number;
  login: string;
  name: string | null;
}
