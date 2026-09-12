# Skills

The loop abstracts an idea from work that landed and offers it back to other projects.

A skill package is layered. The Worker reads the layers separately. The declared
fields (trigger condition, namespaces, termination test, composition interface) live on
the `improve_skills` row as well as in the repo's `SKILL.md` frontmatter, so the Worker
matches a trigger and enforces a status without cloning a repository. The instruction
body is a document, and it is what an edit is measured and bounded against. The repo
copy is the reviewable source. The stored copy is what the machine acts on, the same
split the policy documents use.

The lifecycle is three states. Every skill starts `candidate`, including one
abstracted from an attempt that was kept. Being born of a success says nothing
about whether the written form helps anybody else. A candidate goes `live` on two
positive evaluations. A live skill goes `retired` on two consecutive non-positive ones.
Retired rows stay, with their record, so the same idea is not abstracted twice from the
same source.

A status changes on evaluation evidence and never on a driver's report of its own
run. Two evaluations minimum in either direction: one result is a sample. Evidence
counts per version and per probe set, so an accepted edit resets it. Edits are bounded
at 20 percent of the instruction lines, counted by distinct lines touched, and accepted
only on strict improvement. A tie is a rejection. Rejected edits are kept in
`skill_edits` and handed to the next optimizer run, so a proposal already refused is not
proposed again.

A skill is credited only when it was used and the verifier reported success.
An offered-and-ignored skill and a run that died on the environment both count as
nothing. Offered and used are both stored on `job_outcomes`. The gap between them is
its own measurement.

Failure notes are not a second score. `skill_failures` carries a note
per reverted attempt and failed job, linked to the skills in use at the time, and the
recommend step attaches the two most recent for each skill it offers. Nothing there
moves a status.

Two live skills whose triggers overlap and whose bodies differ by less than 10 percent
are proposed for merging, to a human. Only live skills. A candidate has not been
evaluated enough to merge, and a retired one is a record.

The evaluation cycle is fortnightly, KV-configurable under
`skills:evaluate:cadence-days` and riding the five-minute tick, which gates on the
cadence before doing anything else. Each cycle runs the namespace's probe set in the
scorer sandbox twice per skill, with it and without it, and records the difference. A
cadence below one day falls back to the default rather than being obeyed.

The console carries a skills panel per namespace: counts by status, the last
evaluation, and the offered-to-used rate, which is the number a reader cannot compute
from the others.

Full model: `docs/schema.md`, under Skill records.
