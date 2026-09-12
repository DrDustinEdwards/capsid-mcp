# Auto-merge policy

What this Worker may merge with no human in the loop. This file is the reviewable
source. The copy the Worker actually reads is the signed document at
`capsid/policy/auto-merge.md` in the store, written from this file and signed with the
same key and envelope as an improve loop task document. An unsigned copy, or one
edited after signing, merges nothing.

- version: 1
- enabled: false
- namespaces: capsid

`enabled` ships as `false`. Turning it on is a ruling, and the document is on the
ordinary write tool's refusal list, so changing it needs `allow_improve_paths: true`
and the `can_touch_protected` flag, and lands in the audit log.

## Checks

Every one of these must pass before a pull request is merged without a human. They are
evaluated in this order, each refuses on its own, and the audit row names every check
that passed before the one that refused.

- `body_names_job` The PR body carries the id of the job the work came from, so a
  merged change traces back to a request somebody made.
- `author_is_driver` That job was claimed by a minted agent whose kind is `driver` and
  which has not been revoked. A PR from a seat, a cron agent, an operator key or a
  person is left for the seat.
- `base_is_default_branch` The PR targets the repo's default branch. A PR onto a
  release or staging branch is somebody's sequencing decision, not this policy's.
- `ci_green` Every check run on the head sha has completed and concluded success,
  skipped or neutral. A commit nothing has reported on is not green: a workflow that
  never started looks exactly like one that was removed.
- `paths_unprotected` No changed path matches `PROTECTED_PATH_PATTERNS`, the same list
  the improve loop enforces: tests, CI, lint and compiler configuration, lockfiles and
  manifests, the agent steering layer, migrations, and the loop's own source.
- `paths_not_money` No changed path names a billing or payment surface.
- `no_migration_workflow_lockfile` No changed path is a migration, a workflow, or a
  lockfile. The protected list already covers these three. Stating them again means
  removing a pattern from one list does not open the other.

Anything else waits for the seat. A pull request that fails any check is left open,
audited with the check that refused it, and reported under `improve_status` as
awaiting the seat.

## What this policy cannot do

It cannot widen the set of repos the Worker reaches: a namespace it names that is not
on the improve roster is refused when the policy is parsed. It cannot describe less
than the code enforces: a check the Worker runs that this document does not name is
refused at load time.
