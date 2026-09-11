import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { bounded, docPath, MAX_DOC_STATUS, nsName } from "../limits";
import { ROSTER as IMPROVE_ROSTER, onRoster, RUN_CONDITIONS } from "../improve-schema";
import { improveControl, improveRunManual, improveStatus } from "../improve-run";
import { fail, ok, type ToolCtx } from "./docs";

export function registerImproveTools(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  // THE IMPROVE LOOP'S TWO TOOLS, a ruled exception to hard rule 1 (the surface is
  // small and stays that way), recorded in capsid/decisions.md alongside the
  // history/restore exception of 2026-08-13. The subsystem is driven by cron, and a
  // cron-only subsystem is one nobody can inspect or start by hand: the 2026-08-09
  // outage went 26 days undetected for that shape of reason.
  server.registerTool(
    "improve_run",
    {
      annotations: hintsFor("improve_run"),
      description:
        `Open improve runs, or control the loop. action defaults to "run": open runs for the roster (or one namespace) and advance them one step, respecting APP_KV improve_mode and skipping paused namespaces; dry_run reports the plan and writes NOTHING. The control actions each write one KV value, audit it, and read it back so the response is the value that actually landed: action "mode" sets improve_mode to value ("off" | "subscription" | "api"); action "pause"/"unpause" sets or clears improve:paused for one namespace or "all" (pause takes an optional reason); action "budget" sets the monthly caps actions_minutes_month and model_usd_month. action "mint_operator_key" generates a READ-ONLY (ro:) operator key, returns it ONCE and stores it nowhere, and prints the exact wrangler command that adds its hash to OPERATOR_KEY_HASH; it deliberately does NOT set the secret itself, because a Worker that can widen its own authorization list does not have one. action "claim" takes the SUBSCRIPTION-MODE DRIVER LEASE for one namespace (improve:driver:<ns>, six-hour TTL): it refuses if the lease is already held and never overwrites the holder, and release: true gives it back at the end of a run. It is best-effort mutual exclusion, not a lock, because KV has no compare-and-set; it stops a second /improve session, not two claims in the same millisecond. improve_status reflects the control actions on its next call. Requires an operator key with the write grant.`,
      inputSchema: {
        action: z
          .enum(["run", "mode", "pause", "unpause", "budget", "mint_operator_key", "claim"])
          .optional()
          .describe('What to do. Defaults to "run". The others control the loop: mode, pause, unpause, budget, mint_operator_key, claim.'),
        namespace: nsName.optional().describe('For "run", limit to one namespace (omit for the whole roster). For pause/unpause, the target namespace, or "all".'),
        value: z.enum(["off", "subscription", "api"]).optional().describe('For action "mode": the mode to set.'),
        reason: bounded(MAX_DOC_STATUS).optional().describe('For action "pause": the reason recorded on the pause key. Defaults to a generic note.'),
        actions_minutes_month: z.number().positive().optional().describe('For action "budget": the monthly Actions-minutes cap.'),
        model_usd_month: z.number().positive().optional().describe('For action "budget": the monthly model-spend cap in USD.'),
        dry_run: z.boolean().optional().describe('For action "run": report the plan and change nothing. Defaults to false.'),
        release: z
          .boolean()
          .optional()
          .describe('For action "claim": release the lease instead of taking it. Defaults to false.'),
        condition: bounded(MAX_DOC_STATUS)
          .optional()
          .describe(
            `For action "run", the experimental condition: ${RUN_CONDITIONS.join(" | ")}. Defaults to full. "no-memory" withholds lineage history from base selection; "no-transfer" offers no cross-project skill. Recorded on the run row and in its audit rows, so an ablation is a query. An unrecognised value is refused rather than defaulted.`
          ),
      },
    },
    async ({ action, namespace, value, reason, actions_minutes_month, model_usd_month, dry_run, condition, release }) => {
      try {
        if (action && action !== "run") {
          return ok(await improveControl(env, action, { value, namespace, reason, actions_minutes_month, model_usd_month, release }));
        }
        if (namespace && !onRoster(namespace)) {
          return fail(
            `namespace '${namespace}' is not on the improve roster (${IMPROVE_ROSTER.join(", ")}). A namespace joins by being added to ROSTER in src/improve-schema.ts and by having its anchor block pinned.`
          );
        }
        return ok(await improveRunManual(env, new Date(), { namespace, dryRun: dry_run === true, condition }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.registerTool(
    "improve_status",
    {
      annotations: hintsFor("improve_status"),
      description:
        "The improve loop's current state: the mode, and per namespace the pause reason if any, whether its anchor block is pinned, the best known commit and score, the last run, and lifetime totals for attempts, keeps, reverts, estimated model cost and CI minutes. Each namespace also carries a jobs block: how many queued, claimed and blocked, how many finished today, and the BLOCKED JOBS THEMSELVES with the command each is waiting on, because a count of blocked jobs tells nobody what to run. It also serves protected_paths, the deterministic path guard's pattern list (source and flags per entry), which the subscription-mode driver rebuilds and applies to each attempt's changed paths before any push, so that guard cannot drift from the Worker's. Read-only. cost_usd is an estimate computed from token counts and published rates, not a bill.",
      inputSchema: {
        namespace: nsName.optional().describe("Limit to one namespace. Omit for the whole roster."),
        task_path: docPath
          .optional()
          .describe(
            "Verify one task document before executing it: pass its path (for example improve/run-2026-09-07.md) together with its namespace. The response gains task_verification { ok, actor, reason }, which checks the HMAC signature against the key this Worker derives AND that the last audit actor is the loop itself. The /improve driver must refuse a doc that does not verify."
          ),
      },
    },
    async ({ namespace, task_path }) => {
      try {
        return ok(await improveStatus(env, namespace, task_path));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
