# Autonomy

What the machine may do with no human in the loop. Both policies ship **disabled**, and
each one lives in two places: a reviewable file in `docs/policy/`, and the copy the
Worker actually reads, a signed document in the store. An unsigned copy, or one edited
after signing, authorizes nothing.

**Auto-merge** (`docs/policy/auto-merge.md`, read from `capsid/policy/auto-merge.md`).
The five-minute tick walks every open pull request on the namespaces the policy names
and merges only those that pass all seven checks, evaluated in order, each refusing on
its own:

| check | what it requires |
| --- | --- |
| `body_names_job` | the PR body carries the id of the job the work came from |
| `author_is_driver` | that job was claimed by a minted, unrevoked agent of kind `driver` |
| `base_is_default_branch` | the PR targets the repo's default branch |
| `ci_green` | every check run on the head sha completed and concluded success, skipped or neutral, and at least one reported |
| `paths_unprotected` | no changed path matches `PROTECTED_PATH_PATTERNS`, the list the loop enforces |
| `paths_not_money` | no changed path names a billing or payment surface |
| `no_migration_workflow_lockfile` | no changed path is a migration, a workflow or a lockfile |

The document names the checks and the code enforces them: a check the Worker runs that
the document does not name is refused at load time, and a test asserts the two agree in
both directions. A pull request failing any check is left open, audited with the check
that refused it, and reported under `improve_status` as awaiting the seat.

**Pre-approved gates** (`docs/policy/gates.md`, read from `capsid/policy/gates.md`). A
driver that reaches a push, a migration or a pull request blocks with the exact command,
and every one of those waits on a person. This policy lets the seat send a bounded one
back in itself: `jobs` action `resume` with `approved_by_policy` set to the document's
version, refused unless the blocked command matches one of three classes.
`additive_migration` is a `wrangler d1 execute` naming a `--file` under `migrations/`
whose every statement is `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` or
`CREATE INDEX`, with an unrecognized statement form a refusal rather than a pass.
`push_branch` is a `git push origin <branch>` for a branch that is not `master` or
`main`, with no force flag. `open_pr` is a `gh pr create`. A never-list is checked over
the whole command before any class is tried: secrets, revocations, force pushes, pushes
to a default branch, `wrangler deploy` and `rollback`, mode changes, drops and deletes,
and merging a pull request, which stays the human's gate. The audit row records which
class matched and what it matched on.

**Signing is admin only.** `improve_run` action `sign_policy` signs the body **already
stored** rather than any body the caller supplies, only in the `capsid` namespace and
only under `policy/`, and a minted agent is refused outright. Turning a policy on is
therefore two deliberate acts: editing the document, which is on the ordinary write
tool's refusal list and needs `allow_improve_paths` plus `can_touch_protected`, and
signing it again afterwards.

**The nightly driver runs on this machine, not in the cloud.** `scripts/schedule-drivers.mjs`
installs one Windows Task Scheduler task per project folder, each invoking `/improve work`
in that folder at 04:00 America/Chicago, so each task reaches Capsid as exactly one
driver agent from its own `~/.capsid/agent-<ns>-driver.key`. A Claude Code cloud routine
was measured and rejected: a routine can attach only claude.ai connectors, the registered
Capsid connector points at `/mcp`, the OAuth admin path, and there is no verified way to
hand a routine a secret, so a nightly routine would run the whole queue on the wide
credential the driver agents were minted to replace. The scheduler is off twice over:
nothing is created without `--apply`, and an installed task is created disabled.

## The watcher

A half-hourly step on the five-minute tick that reads the surface and, when something is wrong, **posts a job**. That is all it does: it holds no blast-radius flag, it is scoped to `jobs.post`, and it cannot claim what it posts or fix what it found.

- **What it reads.** `/health` against master (degraded store, a deployed sha that is not master head, a backup older than the window or that never ran, a live schema behind the newest migration); `improve_status` (a pause the loop set itself, a monthly cap over 80 percent); blocked jobs older than a day; and CI on each roster repo's default branch, red for more than two hours.
- **A healthy surface posts nothing**, and a pause a human set is not a finding. A watcher that cried every half hour would be muted inside a week, and the queue would still look watched.
- **Deduplication is the queue's own rule.** The finding's fingerprint goes in the job title, and `post` already refuses a duplicate while one is open, so a finding posts once and stays posted until it clears. A finding that stops being found has its job failed with `cleared`, keyed on `queued` so a job a driver has claimed is never closed underneath it.
- **Cadence** is `watcher:cadence-minutes` in `APP_KV`, 30 by default, with a floor of 5. It rides the tick before the budget check, with the lease sweep and auto-merge, because it spends no model tokens and no CI minutes and an exhausted budget is exactly when nobody is looking.
