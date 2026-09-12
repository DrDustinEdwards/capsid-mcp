# The knowledge model

Capsid stores documents. This describes how they are organised and what the rules
around them are, so that reading this repository is enough to understand the
system without an account on the running server.

**This document is redacted from the private canon.** Capsid documents itself, in
itself, and those documents are the authority. What is here is the model; what is
not here is the content, the namespace inventory, and the rulings. Where the two
ever disagree, the private document is right and this one is stale.

## Documents

A document is a row: namespace, path, title, body, type, status, tags,
`created_at`, `updated_at`.

- **Namespace** is a project, one per repository. It is also the authorization
  boundary for repository access: the namespace-to-repository mapping is what
  decides which repository a tool call can reach, so an unmapped selector is
  rejected rather than guessed at.
- **Path** is a flat filename inside a namespace, like `decisions.md`. Structure
  lives in the path and the type, never in nested namespaces. Consolidated raw
  material moves under an `archive/` prefix and stays there.
- **Body** is markdown. FTS5 indexes title and body, kept in step by triggers on
  the documents table, so search is a property of the write rather than a
  separate job that can fall behind.

### Types

| type | what it is |
| --- | --- |
| `core` | one always-loaded summary per namespace, read first to orient |
| `concept` | a compiled wiki topic, one subject per document |
| `decision` | a ruling and the measurement that forced it |
| `spec` | a design a piece of work is built to |
| `protocol` | a tested procedure |
| `procedural` | rules for working in a namespace |
| `task` | an open piece of work |
| `reference` | pointers outward: URLs, dashboards, lookup tables |
| `semantic`, `note`, `post` | compiled knowledge and content |
| `episodic` | a session record: raw material for the consolidation loop |
| `source` | raw, un-compiled input, an inbox |
| `prompt` | a reusable template, with `{{variable}}` placeholders |

The write path validates the type. An unknown type is refused rather than stored,
because a document with an invented type is invisible to every query that names
the real ones.

### Statuses

`draft`, `ready`, `active`, `published`, `superseded`. `published` is the default.

**Status records editorial state and NEVER decides what the consolidation loop can
see.** Only the `archive/` prefix does that. This rule has a scar behind it: while
the loop's queries filtered on `status = 'published'`, documents written as
`active` were invisible to the backlog count, absent from the consolidation
packet, and therefore unreachable by the step that archives what the packet
surfaced. The gate read 2 against a real backlog of 24 and waved through five
consecutive sessions.

## Links

Documents carry typed outgoing edges: `governs`, `references`, `supersedes`,
`replaces`, `depends-on`. An edge names a namespace and a path on both ends, so it
can cross namespaces.

Edges are moved by the same helper that moves a document, which is the only reason
a rename does not orphan them. An edge whose endpoint no longer exists is
**reported, never auto-repaired**: a dangling edge usually means the target was
renamed by hand or removed before a delete cascaded, and which of those it was
decides whether the fix is repointing the edge or dropping it. That is a judgement,
and a program making it silently would be worse than the dangling edge.

## The write path, and what it guarantees

Four invariants, each enforced in code rather than by discipline:

1. **Every overwrite and every delete snapshots the prior row** into a versions
   table and appends to an audit log. There is no write path that skips either.
   Retention on snapshots is by age.
2. **A path mutation goes through one helper and nowhere else**, and a mutating
   batch carries its own existence predicate, so a zero-row move or delete aborts
   instead of reporting success. Row counts from the database cannot be used for
   this: the FTS triggers inflate them.
3. **Writes normalize wide dashes to ASCII server-side**, so no client can store
   an em dash regardless of what it sends. Scope: document writes only. Repository
   writes pass content through verbatim, which is a known and deliberate gap.
4. **An optional `if_match` is enforced at commit time**, inside the mutation
   batch, against the body itself rather than a stored hash. A mismatch aborts the
   whole transaction and returns the current hash to rebase against. Racing
   creates resolve to one winner and one refusal.

## Write modes

A write is one of four modes, and the reason there are four is that amending a
large document used to mean re-emitting the whole thing:

- `replace` writes a full body.
- `append` adds to the end. No title needed, no confirmation, because nothing is
  overwritten.
- `patch` replaces an anchored region. The anchor must occur **exactly once** or
  the write is refused, so a missed or ambiguous anchor cannot silently corrupt a
  body. Mismatched line endings are the usual cause of a missed anchor.
- `meta` changes type, tags, status or title and leaves the body byte-identical,
  normalization included.

Every mode returns the sha256 and byte count of the stored body, so a write is
verified without reading the document back. Pass that hash as `if_match` on the
next write to the same document and the server enforces the re-read rule for you.

Three instruments fall out of this for free, and all three have been used in
anger:

- **A `patch` whose anchor equals its replacement is non-destructive.** A match
  changes nothing and returns the same hash and byte count; a mismatch is a
  refusal that writes nothing. Use it to prove a moved block byte-exact at its
  destination, to read a document's current size without touching it, or to
  confirm an anchor exists exactly once before betting a real patch on it.
- **A deliberately wrong `if_match` is a non-mutating hash oracle.** The server
  refuses, writes nothing, and returns the current hash.
- **A hash computed locally over the body a read returned IS the stored hash**, so
  a session that has already read a document does not need a write to obtain one.

## The consolidation loop

Raw material accumulates; the loop compiles it. The server orchestrates and does
no reasoning: whichever client is driving does all of it with the ordinary read
and write tools.

1. **gather** (read-only) returns the packet: the current `core.md`, the compiled
   concept and decision documents, every episodic and source document not yet
   archived, and the rules documents. It is size-bounded, and when it trims it
   stubs whole documents rather than truncating bodies, because a truncated
   markdown document is worse than an honest stub: the reader cannot tell they are
   holding a fragment.
2. The driving client compiles: dedupes, resolves contradictions, refreshes
   cross-references, and writes the results with the ordinary write tool.
3. **finalize** archives the consumed documents by moving them under `archive/`,
   in one batch, with one audit row. **Archive only, never delete.** gather
   excludes `archive/`, which is what makes the loop idempotent.

### report

A third mode measures the store instead of compiling it, and writes what it found
to `<namespace>/reports/lint-<date>.md`. Six checks: contradictions (prose
asserting a number the artifact disagrees with), stale decisions, unbound specs,
broken links, documents by type, and doc-vs-code drift, where a repository path
named in the canon is no longer in the repository.

It produces **one integrity percentage**: subjects in good standing over subjects
judged. A check that could not run is excluded from the number rather than counted
as clean, and says so. An empty store scores null, not 100.

The trend is the point. A number in a tool response is a number one session saw; a
number in a dated document is a series.

## Beyond tools

- **Resources.** Every document is addressable at `capsid://<namespace>/<path>`.
- **Prompts.** Every `prompt` document appears in the prompt list, with its
  `{{variable}}` placeholders as required arguments. `prompts/get` substitutes
  them and returns the body **as an embedded resource, not as user text.** That
  distinction matters: a document body is writable by any session holding
  a write grant, and returning it as plain user text hands whoever last wrote that
  row a message the client's model reads as its own operator speaking.

## Jobs as evidence

A finished job writes one row to `job_outcomes` (`migrations/0011_job_outcomes.sql`),
so the queue produces the same kind of evidence the improve loop does. Before it,
the only record of how a job went was `result_summary`: prose, written by the party
being measured, which is the one kind of evidence that cannot be checked.

One row per job, keyed by `job_id`, written by `complete` and by `fail` alike. A
record of successes only is not a record.

| column | what it is |
| --- | --- |
| `agent`, `namespace` | who did the work and where, copied from `jobs.claimed_by` at the moment the job ended rather than joined, since a later lease expiry clears that column |
| `prs_opened`, `prs_merged` | GitHub's answer whenever the driver named any pull request |
| `commits`, `files_changed` | the pull requests' own counts when there are any, the driver's otherwise |
| `tests_added` | the driver's claim, never verifiable here: "a test was added" is a judgement about a diff, not a property of it |
| `ci_green` | `1`, `0`, or `NULL` for not checked. A run still going is `NULL`, because "CI has not answered" is not "CI failed" |
| `blocked_count`, `resumed_count` | how many gates the job hit and how many times a human sent it back, the two numbers the Worker knows first-hand |
| `duration_minutes` | claimed to recorded. The FINAL working stretch: `resume` takes a fresh lease, so time spent blocked waiting on a human is excluded |
| `result_kind` | `pr`, `doc` or `none`, derived from `result_ref` rather than declared |
| `verified` | a JSON object of booleans saying which of the above this Worker checked itself |

**The Worker never stores a count it could check and did not.** The driver reports;
this Worker holds a GitHub App token and can ask. Where a check ran the stored
number is GitHub's and the field is marked verified; where it could not run the
driver's number is stored and the field is not. A table that mixed the two would be
worse than no table, because it would look like measurement.

**Partial verification is not verification.** If any named pull request cannot be
read, every count on that row stays the driver's and every flag stays false: a
merged count over the subset that happened to resolve is a smaller number presented
as a total, which is how a count lies without anybody writing a wrong number.

**`NULL` is not zero.** A field nobody reported is `NULL`; a field somebody counted
and found empty is `0`. An average over a column that spelled both the same way
would be an average over a lie.

### A swallowed parameter tag is refused

`complete`, `fail` and `post` refuse a `result_summary`, `reason` or `body` that
contains the literal text `</name>` for one of the `jobs` tool's own parameter
names, and the refusal names both the field and the tag.

This is a measured failure, twice on 2026-09-11, not a hypothetical. A caller that
closes a parameter tag inside a value sends one argument where it meant to send
three: `result_ref` and `evidence` never arrive as arguments at all, they arrive as
literal text in the middle of `result_summary`. Both times the job was completed
with no reference and no evidence, and the outcome row recorded nothing.

It is refused rather than cleaned up because what was lost is the STRUCTURE, not the
text: stripping the tags would leave a tidy summary still missing its `result_ref`
and its `evidence`, and the caller would never learn. And the outcome row cannot be
corrected afterwards by design, so before the write is the only place to catch it.

The match is the full `</name>` spelling and nothing looser, so prose ABOUT the rule
is not refused: a job body that writes the pieces apart, as this feature's own job
body did, passes. `test/jobs.test.ts` checks both directions, against the actual
stored text of the first job it happened to.

### agent_record

`src/agent-record.ts` aggregates those rows into one record per credential, served
in `improve_status`'s `agents` and rendered on the console: jobs done, failed and
blocked, gates hit, resumes, pull requests opened and merged, a merge rate, a CI
green rate with `ci_checked` as its stated denominator, a median duration, and for
drivers the loop's kept and reverted counts.

Three rules it will not bend. **Counts and rates, never a composite score**: a
score needs a weighting, a weighting is an opinion, and the moment one number
stands for all of them somebody gates on it. **Only a verified field feeds a rate**,
since a rate built partly from what a credential reported about itself is a
credential grading its own work. **A rate with no denominator is `null`**, because
reporting `0%` for an agent that has opened no pull requests puts it below one that
opened ten and merged one.

`jobs.post` can require a record with `min_record` (`{prs_merged: n}`), checked at
the claim against this same function, so the bar a claim is measured against is the
number a human can read on the page.

## Roles, and what each one cannot do

Ruled 2026-09-12. **Roles are few and separated, and a role is one capability rather
than a bundle.** `scripts/mint-agents.mjs` holds them and a test fails the build if any
role names a second blast-radius flag, because a role that accumulates flags is a
driver wearing a different name.

**A reviewer never writes code.** Commenting on a pull request goes through
`manage_pr`, which is a write tool, so the reviewer needs the write grant; `can_comment_pr`
is what stops that grant also being merge and close. It is the smallest write this
Worker makes, separated from the largest on purpose.

**The tools axis can name an action.** `jobs` is one tool with a read action and seven
write ones, and "may post a job" and "may claim, complete and resume one" are different
authorities the tool name cannot separate. So an entry may be qualified, `jobs.post`,
and the rule is stated once in `allowsToolAction`:

- `*` allows everything, so every agent minted before this is untouched.
- A list naming at least one action **of this tool** is narrowed to the actions it names.
- A bare tool name with no qualified sibling still means the whole tool. Narrowing is
  opted into, never inherited.
- A qualified entry narrows only its own tool.

The two tools whose action decides what they do, `jobs` and `lint`, pass the action to
`checkScope` where it is known. That is the same shape the grant check already used and
not a second enforcement point.

## Two corrections, then a human

`resume` made a gate a pause rather than an ending (migrations/0007), and left the loop
unbounded: block, sent back, block again, sent back again, block again. Every step is
defensible on its own, which is why the ceiling is **counted rather than argued** at
each one.

`jobs.corrections_count` (migrations/0016) is that ceiling's budget. It is deliberately
a third counter beside `blocked_count` and `resumed_count`, which are history and are
never reset: those answer "how many gates has this job hit" and "how many times has it
come back", and deriving the budget from them would tie the cap to gates the job passed
legitimately.

- `resume` spends one. At `CORRECTION_CAP` (2) a further resume is refused for a driver
  **and for the seat**, because the seat is a machine and the cap exists to put a person
  at the boundary.
- An **admin** resume passes and does **not** spend the budget. The human arriving is
  what lifts the cap, not what spends it.
- `block` writes `retry cap; human decision required` into `result_summary`, above
  whatever the driver said rather than instead of it: the person now deciding needs to
  read what the driver was trying to do.
- `atCorrectionCap` **fails closed**. A count that is not a finite number at or above
  zero is treated as at the cap, because a budget that cannot be read is one that cannot
  be bounded.

## The review gate

`jobs.review_required` (migrations/0017) says a job's work needs a second reader before
it reaches the seat. A gate on the **row**, checked by the Worker, because the
alternative is a driver remembering to wait, which is the party being reviewed deciding
whether it is reviewed.

**A review is a comment** whose body starts with `REVIEW:` and ends with `APPROVE`,
`CHANGES` or `BLOCK`. Deliberately not a GitHub review approval: the reviewer agent holds
`can_comment_pr` and nothing else, so a comment is the only mark it can leave, and
reading the thing the credential can actually write is what keeps the credential narrow.

The envelope is strict at both ends and `src/review.ts` states why. A comment that opens
with `REVIEW:` and trails off is a reviewer who did not finish, and inventing a verdict
there is the one thing this parser must never do; a comment ending in `APPROVE` without
the prefix is ordinary prose that happens to end in a word.

**The newest review wins**, ordered by timestamp rather than by the order GitHub
returned, because a reviewer that said `CHANGES`, watched the driver fix it and then
said `APPROVE` has changed its mind.

| verdict | what happens |
| --- | --- |
| none yet | the job stays claimed and its lease keeps running |
| `APPROVE` | the hand-off proceeds exactly as it would with no reviewer |
| `CHANGES` | back to the driver, and it **spends a correction** from the budget above |
| `BLOCK` | blocked for the seat, with the objection as the reason |

Both `complete` and `block` consult it. A gate on one of them is not a gate: the driver
would use the other and the bypass would look like ordinary use. A job with no
`review_required`, or one whose `result_ref` is not a pull request, proceeds untouched.
**An unreadable GitHub holds the job** rather than waving it through, since an unreadable
comment list is not evidence that anybody read the code.

## Skill records

A skill is an idea abstracted from work that landed, written down so another project
can act on it. `improve_skills` has held one row per skill since the first improve
migration; migrations 0012 and 0013 gave those rows a lifecycle and the evidence to
move through it.

**The rule the whole thing rests on: a skill's status changes on evaluation evidence,
never on a driver's judgement of its own run.** A driver reporting that a skill helped
is the party being measured reporting the measurement.

**Three states.** Every skill starts `candidate`, including one abstracted from an
attempt that was kept: being born of a success is not evidence that the written form
of the idea helps anybody else, which is the only thing an evaluation measures. A
candidate promotes to `live` on two positive evaluations. A live skill goes `retired`
on two consecutive non-positive ones. Retired rows are kept with their whole record,
both because a retirement is evidence about what does not work and because the
creating path checks them, so the same idea is not abstracted again from the same
source next month.

**Two evaluations minimum, in both directions.** One result is a sample. A system that
promoted on one would spend its life promoting and retiring the same skill on noise.
Promotion and retirement have deliberately different shapes: promotion asks for a
pattern of helping, retirement asks for a run of not helping, so a live skill that
alternates positive and neutral is doing something and stays.

**Evidence is counted per version and per probe set.** An evaluation of version 2 says
nothing about version 3, and a delta measured against a different probe set is not
comparable to one measured against this one. So an accepted edit costs a skill every
evaluation it had accumulated, which is what makes the edit bound matter rather than
being a formality.

**Edits are bounded at 20 percent of the instruction lines**, counted by distinct
lines touched, and accepted only on strict improvement. A tie is a rejection: an edit
that changes nothing measurable still resets the evidence. Rejected edits are stored
in `skill_edits` and handed to the next optimizer run, so a proposal that was already
refused is not proposed again.

**Attribution separates three things a single counter conflated.** A skill moves only
when it was used AND the verifier reported on the work itself. A skill that was
offered and ignored while the run succeeded anyway earns nothing, because the success
is not its. A run that died on the environment earns nothing either, because charging
a loss for a failed checkout would retire skills for being present during an outage.

**Offered and used are both stored**, on `job_outcomes`. The gap between them is its
own measurement: a skill offered fifty times and used twice is not a failing skill, it
is a trigger condition that does not describe the work it is matched to, and those are
different problems with different fixes.

**Failure notes are not a second score.** `skill_failures` carries a note per reverted
attempt and failed job, linked to the skills in use at the time, and the recommend
step attaches the two most recent for each skill it offers. Nothing there moves a
status; it exists so the next driver reads the failure rather than repeating it.

## Why documents carry provenance

Reads return `last_actor`: the actor from the most recent audit entry for that
document. A document is data, and a document another client wrote is untrusted
input. The stamp is on the response envelope rather than in the body, because the
body is exactly what an attacker controls.

## The console's JSON twin

`GET /console.json` serves the object the `/console` page renders, so a dashboard
or a chat reads the same state without scraping HTML. Admin session only, on the
same gate as the page. The two cannot drift: the page is rendered from this
object, and a test asserts a deep equality between the response and the function
that builds it.

```json
{
  "generated": "2026-09-11T14:00:00.000Z",
  "viewer": "<the admin's github login>",
  "health": {
    "status": "ok | degraded",
    "sha": "<deployed git sha>",
    "dirty": false,
    "builtAt": "<build time, or null>",
    "schema_version": "<newest applied migration, or null>",
    "store": { "d1": "ok", "fts": "ok" },
    "backup": { "last_ok": "<timestamp>", "age_hours": 5, "warning": "<only when stale>" }
  },
  "improve": "<the improve_status report: mode, budget, protected_paths, agents, namespaces>",
  "agents": [
    {
      "name": "capsid-driver",
      "kind": "driver",
      "namespaces": ["capsid"],
      "grants": ["read", "write"],
      "flags": ["<only the flags this agent holds>"],
      "last_seen": "<timestamp, or null>",
      "revoked_at": "<timestamp, or null>",
      "jobs_completed": 4,
      "jobs_failed": 0,
      "jobs_blocked": 1,
      "prs_opened": 2,
      "prs_merged": 0,
      "attempts_kept": 6,
      "attempts_reverted": 14,
      "record": {
        "actor": "agent:capsid-driver",
        "jobs_done": 4,
        "jobs_failed": 0,
        "jobs_blocked": 1,
        "gates_hit": 2,
        "resumed": 2,
        "prs_opened": 4,
        "prs_merged": 3,
        "pr_merge_rate": 0.75,
        "ci_checked": 3,
        "ci_green_rate": 1,
        "median_duration_minutes": 41,
        "attempts_kept": 6,
        "attempts_reverted": 14
      }
    }
  ],
  "activity": [
    { "at": "<timestamp>", "actor": "github:...", "action": "console-pause", "namespace": "capsid", "path": null }
  ],
  "activity_filter": { "namespace": null, "actor": null }
}
```

Three things the shape is deliberate about. `improve` is the whole
`improve_status` report rather than a copy of parts of it, so the console and the
tool serve one description of the loop. `agents` is that report's inventory with
counts attached, and `attempts_kept` and `attempts_reverted` are `null` for every
kind except `driver`, because an attempt belongs to a namespace's runs and
crediting a seat with them would be attributing one credential's work to another.
`activity_filter` echoes what the query string asked for, so a reader can tell a
filtered view from the whole log.

`record` is the agent record, and it is not the same measurement as the counts
beside it. The flat `prs_opened` and `prs_merged` count what this credential did
through this Worker, from `audit_log`. The record's counts come from
`job_outcomes`, and its RATES come only from the fields the Worker checked against
GitHub itself, which is why a driver can show pull requests in one and a `null`
rate in the other: it opened them without naming them as evidence on a job. A rate
with no denominator is `null` rather than `0`, because `0%` would sort a credential
that has done nothing below one that has done something imperfectly.

No key, no stored verifier and no CSRF token appears here. The token is minted per
page render and belongs in a cookie and a form, not in a document any reader of
the twin could copy.
