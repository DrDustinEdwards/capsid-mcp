# The improve loop

A nightly loop that tries small changes to a handful of projects, has each
project's own CI measure whether they helped, keeps the ones that did and reverts
the rest. It is off by default and it never merges anything.

**This document is redacted from the private canon.** The roster, the scores, the
holdout contents and the rulings are not here. What is here is the design.

## How it runs

- **Modes.** `subscription` has the Worker write a task document for a session to run, so it calls no model itself. `api` calls the model directly. `off` is the default, and any unreadable or unexpected setting falls back to it.
- **Cadence.** A nightly opener (a Cron Trigger at 03:00 America/Chicago) starts a run per eligible namespace; a five-minute tick advances any run in flight.
- **Scoring runs in two jobs, and the second never puts attempt code on the runner.** `build` checks out the attempt branch and runs that repo's build, tests, lint and bundle measurement with no credential in its environment. `score` checks out the default branch only and runs the hidden holdout suite in a network-less, read-only container with the attempt mounted read-only, reading results from its stdout pipe. `score` is byte-identical across all five roster repos; only `build` differs. `scripts/sync-scorer.mjs` re-copies it and its dry run verifies the copies match.
- **No long-lived scoring credential.** The score job asks the Worker for a one-hour, object-read-only credential scoped to that namespace's `HOLDOUT` prefix, minted per run and signed with the same per-namespace key as the score report.
- **Keep or revert.** A change that regresses a pinned anchor metric, or fails to improve the weighted score, is reverted; one that improves it opens a pull request. Anchors are checksummed and pinned, and a mismatch refuses every run for that namespace until a human re-pins.
- **Protected paths.** Tests, CI configuration, lockfiles, manifests, compiler and lint config, migrations, the agent steering layer and the loop's own files are off limits to an attempt, enforced by a deterministic path guard. These files define the score; an attempt may not change what scores it.
- **Budget, pause and one driver.** Monthly caps on estimated model spend and CI minutes stop the loop when exceeded. A per-namespace pause key holds that namespace until a human clears it. In subscription mode a KV driver lease (six-hour TTL) keeps two sessions off one namespace.

`improve_status` reports the mode, the budget, the protected-path patterns, the agent inventory and each namespace's state, including queued and blocked jobs. `improve_run` starts or resumes a run by hand.

## Why it is shaped this way

A Worker cannot run a build or a test suite. There is no process to spawn.
Scoring happens in each repository's own CI, with its real toolchain, and the
result comes back over a signed endpoint.

A run cannot finish in one cron invocation. CI takes minutes. A run is a
small state machine in the database, and a tick every five minutes advances
whichever runs are unfinished, one step at a time. Every step is safe to repeat,
because ticks overlap and isolates die mid-flight. Every transition is
`UPDATE ... WHERE status = <expected> RETURNING id`, never a row count.

The loop cannot move its own goalposts.

## What stops it moving its own goalposts

### The scores document

Each project has a scores document with two sections, and they are governed
differently.

**Anchors** are the floor. The loop may never regress them and may never edit
them. This section is checksummed and the checksum is pinned out of band; if the
section changes, every run for that project refuses until a human re-pins it.

**Secondary** metrics are what the loop optimises. This section is not
checksummed, so reweighting a metric is a free edit. Covering the whole file
would mean every legitimate tuning change breaks every run until someone
refreshes the pin, and the failure would be a refusal at 03:00 that nobody sees
until morning. Checksumming the anchor block gives the property that actually
matters and leaves the tuning surface tunable.

A metric may be marked `stub`: parsed, reported, and excluded from scoring until
the marker is removed, so declaring an intention never scores as a zero.

A metric is declared only once something reports it. Two metrics were declared
in every scores document for weeks and emitted as a literal null on every run by
every repository. A document that lists a metric nobody measures reads as five
signals and behaves as three. The scorer now exports the list it actually
reports, and a test derives the documents' list from it and fails in both
directions.

### The path guard

A deterministic check refuses any change touching tests, CI configuration, lint or
compiler configuration, lockfiles, package manifests, migrations, or the loop's
own files. It runs with no model and cannot be argued with. Those paths are what
measure the work. An attempt may not change them.

Getting the lockfile list right matters more than it looks: the scorer installs
from a lockfile before it runs anything, so an unprotected lockfile for the fifth
package manager is code execution in the job that holds the signing key. The list
covers every package manager's lockfile and workspace file, and a test asserts it
so the sixth one cannot quietly reopen the hole.

### The isolated scorer

Attempt code executes in exactly one place: a container with no network, a
read-only root, and every mount read-only, whose only writable surface is a tmpfs
that dies with the run. Its results leave as a stdout pipe. Markers carry a
per-run nonce the trusted shell drops from the environment before any attempt
code runs.

### Anchors do not come from the artifact

The build result is a job output the CI runner sets from a step's own outcome.
Metrics written to a file on a runner that has already executed attempt code are
treated as hostile for that field, because they are.

The two secondary metrics that can be recomputed are recomputed inside the same
container, from the repository's own commands, taken from a map on the default
branch. The one that cannot (bundle size, which needs a bundler) still comes from
the artifact, and is cross-checked: a disagreement is logged and the container's
value wins. A phase that could not run reports null rather than falling back to
the artifact, because an unmeasured metric must never be readable as the number
the attempt wrote down.

How that was verified. A branch was pushed that genuinely broke two tests and
deleted the test file that catches it, so the build job measured a perfect suite
and wrote it into the artifact. The container ran the default branch's tests
against that source and reported 0.9906. Both mismatches were logged and the
signed report carried the measured numbers.

### The hidden suite

A held-out test suite lives in its own bucket with its own binding. The code that
generates attempts is handed an environment that structurally does not contain
that binding, so it cannot read the hidden tests: removing the type breaks the
compile. A source scan enforces that only one module may name the binding, and the
runtime environment still has it. Three layers, each defeating a different
evasion.

CI pulls the suite with a one-hour, object-read-only credential minted on
request and signed with the same per-project key as the score report, rather than
a long-lived account-wide token.

The size is declared in a manifest the attempt cannot write. A report claiming
fewer tests than the manifest declares is refused outright. A project with no
manifest is refused too: a project with no hidden suite would otherwise
score exactly like one with a passing suite.

### The task document is signed

In the mode where a human session drives the loop, the Worker writes a task
document and the session executes it. That document is executed as an instruction
list, on a machine holding repository clones, local git and a write grant. It is
signed. The ordinary write tool refuses its path without an explicit audited flag.
Verification requires both a valid signature and an audit actor that is the loop
itself.

## What is measured, and when a change is kept

An attempt is kept only when no anchor regressed and the weighted secondary
score strictly improved. A tie reverts, because churn accumulates into a diff
nobody can review.

An anchor CI did not report counts as failed, never as skipped. A comparison with no comparable
metrics reverts and says so.

## What stops it, in increasing order of scope

- **The reward-hacking monitor**, per attempt. The deterministic path check above,
  plus a model reading the diff for the cases a pattern cannot name. If either
  fires, the attempt is reverted whatever it scored, because a change that games
  the scorer scores well.
- **Consecutive reverts**, per run. The run restores to the best known commit and
  stops.
- **The drift gate**, per project. Too many reverts across recent runs, or any
  anchor dropping against the best recorded run, pauses the project. The pause key
  has no expiry: an expiring pause silently resumes a project
  that was stopped for a reason nobody has looked at.
- **The mode back to off**, for everything. An unset key, an unrecognised value,
  or an unreadable store all mean off.

## What a run leaves behind

Nothing is deleted, ever. One row per attempt with its lineage parent, its scores
on both sides and why it was kept or reverted; one archive document per attempt,
written before the score arrives so an attempt that is never scored still
leaves a record; one run summary; and an audit row for every step. Every table is
in the nightly backup, so the lineage survives outside the database.

## What it does not do

- It does not merge. Kept changes arrive as a pull request and sit there.
- It does not touch a project without a scores document and a pinned checksum.
  There is no opt-in by existing.
- It does not edit tests, CI, or its own scoring.
- It does not run on a project that is not on the roster in the source.
