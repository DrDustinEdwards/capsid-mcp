import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { AGENT_KINDS, SCOPE_FLAGS, AGENT_GRANTS } from "../agents-schema";
import { listAgents, mintAgent, revokeAgent, updateAgentScopes } from "../agents-admin";
import { bounded, MAX_DOC_TYPE, nsName } from "../limits";
import { fail, ok, type ToolCtx } from "./docs";

const AGENT_ACTIONS = ["mint", "list", "revoke", "update_scopes"] as const;

export function registerAgentTools(server: McpServer, ctx: ToolCtx): void {
  const { db, agent, actor } = ctx;

  // THE CREDENTIAL CONTROL PLANE'S ONE TOOL, a ruled exception to hard rule 1 taking
  // the surface from 31 to 32 (capsid/decisions.md, 2026-09-11). The FIFTH, after
  // history and restore (2026-08-13), improve_run and improve_status (2026-09-04),
  // the repo fallthrough widening (2026-09-06) and jobs (2026-09-10).
  //
  // The argument is the same one the improve loop and the queue made, and it is the
  // only argument this repo accepts for a new tool: a control plane nobody can reach
  // from a chat is one that gets worked around. The alternative here was minting by
  // hand with wrangler and a SQL statement, which means a human pasting a key hash
  // into a shell, and a scope system whose rows are written by hand is a scope system
  // with no audit trail and no validation.
  //
  // Four actions on one tool rather than four tools, for the same reason jobs carries
  // eight: one subsystem, one row shape, and a caller that has the tool has the whole
  // lifecycle.
  server.registerTool(
    "agents",
    {
      annotations: hintsFor("agents"),
      description:
        `Scoped credentials: one row per caller, with its own key, its own scopes and its own audit identity. ADMIN ONLY, every action: a minted agent cannot mint, revoke or re-scope another, because an agent that can widen itself has no scope. The admin is an OAuth session on /mcp or a write-grant OPERATOR_KEY_HASH entry on /ops/mcp. action "mint" creates an agent and RETURNS ITS KEY ONCE: the key is stored nowhere, the table holds its sha256, and a lost key is replaced by revoking and minting again. It takes name (unique forever, revoked names included, because it is the audit identity), kind (${AGENT_KINDS.join(" | ")}), namespaces (the list it may reach, or the single entry * for all), and optionally repos, tools, grants and flags. A new agent defaults to READ on its named namespaces with no flags; widen it deliberately. The flags are the blast radius, each naming an action whose consequence leaves this Worker: ${SCOPE_FLAGS.join(", ")}. action "list" is the inventory, REVOKED ROWS INCLUDED, with each agent's scopes, last_seen and a 12-hex fingerprint of its key digest; the stored verifier is never returned. action "revoke" sets revoked_at rather than deleting, so the audit rows an agent wrote still resolve to what it was allowed to do, and its key stops resolving immediately. action "update_scopes" replaces named axes and leaves the rest: a call naming one flag does not clear the others. Minting and re-scoping are audit-logged with the scopes and, for a mint, the key's fingerprint. Never the key.`,
      inputSchema: {
        action: z.enum(AGENT_ACTIONS).describe("mint | list | revoke | update_scopes."),
        name: bounded(64).optional().describe("For mint, revoke and update_scopes: the agent's name, which is its audit identity (agent:<name>)."),
        kind: bounded(MAX_DOC_TYPE).optional().describe(`For mint: ${AGENT_KINDS.join(" | ")}. Descriptive, not authorizing: what an agent may do is in its scopes.`),
        namespaces: z
          .array(nsName)
          .optional()
          .describe('For mint (required) and update_scopes: the namespaces this agent may reach, or the single entry "*" for every one.'),
        repos: z.array(bounded(128)).optional().describe('Repo selectors this agent may target, or the single entry "*". Defaults to every repo of the namespaces it is scoped to.'),
        tools: z.array(bounded(64)).optional().describe('Tool names this agent may call, or the single entry "*". Defaults to every tool its grant allows.'),
        grants: z.array(z.enum(AGENT_GRANTS)).optional().describe(`read, or read and write. A new agent gets read.`),
        flags: z
          .object(Object.fromEntries(SCOPE_FLAGS.map((flag) => [flag, z.boolean().optional()])))
          .optional()
          .describe(`The blast-radius flags: ${SCOPE_FLAGS.join(", ")}. Absent means unchanged, never cleared. Every one defaults to false at mint.`),
      },
    },
    async (args) => {
      try {
        if (!agent.admin) {
          return fail(
            `unauthorized: '${args.action}' on agents is admin only, and ${actor} is a minted agent. ` +
              `An agent that can mint or re-scope another can widen itself, which would make every scope below it decoration. ` +
              `Call this as the OAuth admin session, or with a write-grant operator key.`
          );
        }
        const scopeArgs = { namespaces: args.namespaces, repos: args.repos, tools: args.tools, grants: args.grants, flags: args.flags };
        switch (args.action) {
          case "mint": {
            if (!args.name || !args.kind) return fail("mint needs a name and a kind.");
            return ok(await mintAgent(db, actor, { ...scopeArgs, name: args.name, kind: args.kind }));
          }
          case "list":
            return ok(await listAgents(db));
          case "revoke": {
            if (!args.name) return fail("revoke needs the agent's name.");
            return ok(await revokeAgent(db, actor, args.name));
          }
          case "update_scopes": {
            if (!args.name) return fail("update_scopes needs the agent's name.");
            return ok(await updateAgentScopes(db, actor, args.name, scopeArgs));
          }
        }
        return fail(`unknown agents action '${args.action}'.`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
