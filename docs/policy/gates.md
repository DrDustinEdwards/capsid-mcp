# Pre-approved gates

Which blocked commands the seat may approve without asking the human. This file is the
reviewable source. The copy the Worker reads is the signed document at
`capsid/policy/gates.md` in the store, signed with the same key and envelope as an
improve loop task document. An unsigned copy, or one edited after signing, approves
nothing.

- version: 1
- enabled: false

A driver that reaches a push, a migration or a pull request stops and blocks with the
exact command. Every one of those then waits on a person, including the ones whose
consequence is bounded and reversible. This is the list of the bounded ones.

The seat is still an ordinary caller with a write grant. What this policy gives it is
the ability to send a job back through `jobs` action `resume` by passing
`approved_by_policy` with this document's version, instead of waiting for a human to
say yes. The command the job blocked on must match one of the classes below, and the
resume is refused when it matches none.

## Classes

- `additive_migration` A `wrangler d1 execute` naming a `--file` under `migrations/`,
  where every statement in that file is `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ...
  ADD COLUMN`, or `CREATE INDEX`. The file is read and every statement is checked.
  Anything the parser does not recognise is a refusal, not a pass, so a statement form
  it has never seen waits for the human.
- `push_branch` A `git push origin <branch>` for a branch that is not `master` or
  `main`, with no force flag.
- `open_pr` A `gh pr create`.

## Never on this list

Checked before any class is tried, over the whole command, so a command that both looks
like a branch push and carries a force flag can never match `push_branch`:

- Setting or deleting a secret, in `wrangler` or in `gh`.
- Revoking a credential.
- A force push, in any of its spellings, or a `+refs/` ref update.
- A push to a default branch.
- `wrangler deploy` or `wrangler rollback`.
- Editing `wrangler.jsonc`.
- Changing the improve loop's mode.
- Dropping a table, index or column; deleting rows; truncating a table.
- Deleting files recursively.
- Merging a pull request, which is the human's gate and stays that way.

## What this policy cannot do

It cannot describe less than the code enforces: a class the Worker would approve that
this document does not name is refused at load time. It cannot approve a command that
matched no class, because the refusal is the default and a match is what has to be
demonstrated. And it ships disabled, so turning it on is a deliberate act recorded in
the audit log.
