import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { bounded, docPath, MAX_BODY, MAX_TITLE, nsName } from "../limits";
import { JOB_ACTIONS, JOB_LEASE_SECONDS, JOB_STATUSES, isJobStatus } from "../jobs-schema";
import { SCOPE_FLAGS } from "../agents-schema";
import { blockJob, claimJob, completeJob, failJob, heartbeatJob, listJobs, postJob, resumeJob } from "../jobs";
import { fail, ok, type ToolCtx } from "./docs";

const MAX_JOB_ID = 64;

export function registerJobTools(server: McpServer, ctx: ToolCtx): void {
  const { env, db, agent } = ctx;

  // THE WORK QUEUE'S ONE TOOL, a ruled exception to hard rule 1 taking the surface
  // from 30 to 31 (capsid/decisions.md, 2026-09-10). Seven actions on one tool
  // rather than seven tools, for the same reason improve_run carries its control
  // actions: they are one subsystem with one row shape, and a caller that has the
  // tool has the whole lifecycle.
  //
  // The exception is the same argument as the improve loop's: a queue nobody can
  // read from a chat is a queue that gets worked around, and the handoff it exists
  // for is between a seat that has no shell and a driver that has no conversation.
  server.registerTool(
    "jobs",
    {
      annotations: hintsFor("jobs"),
      description:
        `The work queue: post work from a chat, claim it from a machine, report back. The jobs table is the source of truth for status; every job also mirrors to <namespace>/jobs/<id>.md so brief and search see it, and that document is rewritten in the same batch as every transition. action "post" (write) queues a job: namespace, title, body (the full prompt the driver executes), optional priority (higher runs first) and gate_required when the work is known to need a human confirmation. The body is SIGNED with the same key and envelope as the improve loop's task documents, and the driver refuses a job whose body does not verify, so an edited row cannot steer a session holding local shell and repo credentials. One open job per (namespace, title): posting a duplicate while one is queued or claimed is refused. action "list" (read) filters by namespace and status. action "claim" (write) takes the highest-priority queued job in a namespace, or a named id, and sets a ${JOB_LEASE_SECONDS / 3600}-hour lease; it refuses if the caller already holds a claim anywhere, and exactly one caller wins a contested job because the claim is a keyed UPDATE with RETURNING. action "heartbeat" (write) extends the lease. action "complete" (write) needs result_summary and takes an optional result_ref (a document key or a PR URL). action "fail" (write) needs a reason. action "block" (write) is for a job that hit a gate and needs the human: it takes a reason and the exact command to run, and blocked jobs are what improve_status surfaces. action "resume" (write) is the way back: BLOCKED IS A PAUSE, NOT AN ENDING. Once the human has run the command, resume moves the blocked job back to claimed for the caller with a fresh lease, takes a required reason recording what was approved, and re-verifies the body's signature, because a blocked job sits in the table for as long as a human takes and resume hands it to a session with shell and repo credentials. Any write-grant caller may resume, deliberately: the seat that approves is routinely not the session that blocked. A job may be blocked and resumed any number of times, and improve_status reports both counts per blocked job. heartbeat, complete, fail and block only fire for the claimed job THIS caller holds, so a lease the tick already expired cannot be finished out from under its new owner. An expired lease returns the job to queued on the five-minute tick. Every action is audit-logged with the caller's github: login or opkey: fingerprint.`,
      inputSchema: {
        action: z.enum(JOB_ACTIONS).describe("post | list | claim | heartbeat | complete | fail | block | resume."),
        namespace: nsName.optional().describe('For post, the namespace the work belongs to. For list and claim, the namespace to filter or pick from.'),
        title: bounded(MAX_TITLE).optional().describe('For post: the title. One open job per (namespace, title).'),
        body: bounded(MAX_BODY).optional().describe('For post: the full prompt the driver executes. Signed on the way in.'),
        priority: z.number().int().optional().describe('For post: higher runs first. Defaults to 0.'),
        gate_required: z.boolean().optional().describe('For post: the work is known to need a human confirmation (a push, a deploy, a secret). The driver stops at it rather than discovering the gate halfway through.'),
        required_flags: z
          .array(z.enum(SCOPE_FLAGS))
          .optional()
          .describe(
            `For post: the blast-radius flags this job's work needs of the driver that claims it (${SCOPE_FLAGS.join(", ")}). The claim refuses an agent that does not hold them and leaves the job queued for one that does. Omit it for work that needs nothing unusual, which is most work.`
          ),
        status: bounded(32).optional().describe(`For list: one of ${JOB_STATUSES.join(" | ")}.`),
        id: bounded(MAX_JOB_ID).optional().describe('The job id, for claim (optional, to take a specific one), heartbeat, complete, fail and block.'),
        result_summary: bounded(MAX_TITLE).optional().describe('For complete: what happened, in a sentence the seat can read without opening the diff.'),
        result_ref: docPath.optional().describe('For complete: where the work landed, a document key or a PR URL.'),
        reason: bounded(MAX_TITLE).optional().describe('For fail and block: why. For resume: what the human approved, which is what the audit row records.'),
        command: bounded(MAX_TITLE).optional().describe('For block: the exact command the human must run. It goes into the summary the console shows.'),
      },
    },
    async (args) => {
      const now = new Date();
      try {
        if (args.action === "list") {
          if (args.status !== undefined && !isJobStatus(args.status)) {
            return fail(`'${args.status}' is not a job status. One of: ${JOB_STATUSES.join(", ")}.`);
          }
          return ok(await listJobs(env, { namespace: args.namespace, status: args.status }));
        }
        // EVERYTHING ELSE CHANGES THE QUEUE, so the grant is checked here rather than
        // at the registrar: `jobs` is one tool with a read action and seven write
        // ones, and the registrar cannot know which this call is.
        const refusal = ctx.scope({ tool: "jobs", grant: "write", namespace: args.namespace });
        if (refusal) return fail(refusal);
        switch (args.action) {
          case "post": {
            if (!args.namespace || !args.title || !args.body) {
              return fail("post needs namespace, title and body.");
            }
            return ok(
              await postJob(env, agent, now, {
                namespace: args.namespace,
                title: args.title,
                body: args.body,
                priority: args.priority,
                gate_required: args.gate_required,
                required_scopes: args.required_flags ? { flags: args.required_flags } : undefined,
              })
            );
          }
          case "claim":
            return ok(await claimJob(env, agent, now, { namespace: args.namespace, id: args.id }));
          case "heartbeat": {
            if (!args.id) return fail("heartbeat needs the job id.");
            return ok(await heartbeatJob(env, agent, now, args.id));
          }
          case "complete": {
            if (!args.id) return fail("complete needs the job id.");
            return ok(
              await completeJob(env, agent, now, args.id, {
                result_summary: args.result_summary ?? "",
                result_ref: args.result_ref,
              })
            );
          }
          case "fail": {
            if (!args.id) return fail("fail needs the job id.");
            return ok(await failJob(env, agent, now, args.id, args.reason ?? ""));
          }
          case "block": {
            if (!args.id) return fail("block needs the job id.");
            return ok(await blockJob(env, agent, now, args.id, { reason: args.reason ?? "", command: args.command }));
          }
          case "resume": {
            if (!args.id) return fail("resume needs the job id.");
            return ok(await resumeJob(env, agent, now, args.id, args.reason ?? ""));
          }
        }
        return fail(`unknown jobs action '${args.action}'.`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // db is destructured for parity with the other tool modules, which take their
  // reads off it directly. The queue's reads go through src/jobs.ts so the
  // transitions and their mirrors stay in one file.
  void db;
}
