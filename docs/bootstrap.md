# Bootstrap

What it takes to stand this up, and what to check before switching the nightly
loop on. Written for a stranger with a Cloudflare account and a GitHub org.

## 1. Configuration

The real `wrangler.jsonc` is **gitignored** and a fresh clone has none. Copy the
example and fill in the ids:

```
cp wrangler.jsonc.example wrangler.jsonc
```

Everything a fresh clone needs to typecheck and test works without it: types come
from `@cloudflare/workers-types` in `node_modules` rather than from generated
bindings. Only `wrangler dev` and `wrangler deploy` need the real file.

## 2. Bindings

| binding | kind | why it is separate |
| --- | --- | --- |
| `DB` | D1 | documents, versions, links, audit log, the loop's tables |
| `APP_KV` | KV | the Worker's own bookkeeping: caches, leases, counters |
| `OAUTH_KV` | KV | the OAuth provider's clients, grants and tokens |
| `MEDIA` | R2 | backups, the markdown mirror, the report sink |
| `HOLDOUT` | R2 | the loop's hidden test suites |

**The two KV namespaces are separate on purpose.** They shared one for a while,
which meant the Worker's caches lived in the same keyspace as the provider's
tokens.

**The two buckets are separate on purpose too**, and it is not tidiness: the code
that generates loop attempts is handed an environment type that structurally
omits `HOLDOUT`, so it cannot read the hidden tests. Merging the buckets would
delete that guarantee.

**Resolve by name, verify by id.** Assert the resolved id equals a pinned value
rather than trusting the name. A name is not an identity, and a Worker pointed at
nothing starts fine and answers healthy while every read errors.

## 3. Secrets

```
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # the .pem contents
npx wrangler secret put GITHUB_CLIENT_SECRET     # the OAuth app secret
npx wrangler secret put OPERATOR_KEY_HASH        # see below
npx wrangler secret put IMPROVE_SCORE_SECRET     # root of the per-project HMAC keys
npx wrangler secret put ANTHROPIC_API_KEY        # only for the fully automated mode
```

Never commit one, and never read, display or log the contents of an env file.

### Operator keys

`OPERATOR_KEY_HASH` is a **comma-separated list of sha256 hashes**. The keys
themselves exist nowhere on the server.

- A plain entry, `<sha256 of the key>`, grants **write**.
- An entry written as `ro:<sha256 of the key>` is **read-only**.

**The prefix is on the ENTRY, not on the key.** The server hashes whatever key was
presented and compares it against each entry with the prefix stripped, so the tier
is a property of what the operator wrote down rather than of what the caller sends.
A read-only key is denied every mutating tool, and one read tool is partially
gated: CI status returns run metadata but withholds the failing job's log tail,
because a build log carries whatever the workflow echoed.

Revoke by removing a hash. Add one by appending. There is a helper for minting a
read-only key: see **Minting a read-only key** below.

## 4. The GitHub App

Capsid reaches private repositories through a GitHub App installation token,
cached in KV. It is a **GitHub App**, not a personal token, so access is scoped to
an installation and revocable in one place.

### Permissions

Each row names the tools it enables and the evidence that the permission is
actually granted, because a permission list copied from a setup guide is a claim
nobody has checked.

| permission | level | what needs it | evidence |
| --- | --- | --- | --- |
| Metadata | Read | resolving the default branch, every other call | implied by every working call |
| Contents | Read and write | reading files and trees, committing, branches, deleting files | exercised continuously since 2026-07-06 |
| Pull requests | Read and write | opening, merging and closing pull requests | exercised continuously |
| Actions | Read and write | reading workflow runs and logs; dispatching a workflow and re-running failed jobs | read confirmed 2026-08-16; dispatch is what the loop uses to score |
| Workflows | Write | committing under `.github/workflows/` | **confirmed by probe 2026-09-07**: a pull request authoring a workflow file succeeded, and was closed immediately |

That last row is the one worth reading twice. **The App can author workflows in
every mapped repository**, so a write-grant operator key can commit CI that runs
with those repositories' secrets. The tools therefore refuse any path under
`.github/workflows/` unless an explicit opt-in flag is passed, and passing it is
audit-logged.

**The granted permission set was not read back from the API**; each row is
evidence from a call that worked. If you are standing this up fresh, grant the
list above and expect to find out which ones you missed by watching calls fail.

### The connector that does not work

The hosted GitHub MCP connector 404s on every private repository in this
installation while the App token reaches them all. That is a known upstream
indexing bug, not a permissions setting: reconnecting, re-running the OAuth flow
and changing the App's repository scope all fail. This repository's own repository
tools exist partly because of it.

## 5. Migrations

Applied by hand, and CI asserts it:

```
npx wrangler d1 migrations apply capsid --remote
npx wrangler d1 migrations list capsid --remote   # must print "No migrations to apply!"
```

The deploy job fails if the live database is behind, which is deliberate: a Worker
deployed against a schema it does not have is a Worker that answers errors on
every write path.

Restore is in README Restore; do not use `wrangler d1 export`.

## 6. Verifying a deploy

```
npm run check          # typecheck src
npm run check:test     # typecheck the unit suite (its own config)
npm run check:integration
npm test               # unit suite, node:test
npm run test:integration   # the whole Worker in workerd, real D1, KV, R2
npm run deploy
npm run verify:live    # the live gate family against the deployed Worker
```

`EXPECT_SHA` asserts which commit is live. **A tool list is cached by the client
at connect time**, so a tool deployed mid-session is invisible until the connector
reconnects; verify a fresh deploy by calling the Worker directly rather than by
waiting.

## 7. Minting a read-only key

`improve_run` has an action for it, so the derivation and the hashing are not done
by hand:

```
improve_run(action: "mint_operator_key")
```

It returns the key **once**, prints the hash, and prints the exact command to
append that hash to `OPERATOR_KEY_HASH`. It deliberately does **not** set the
secret itself: a Worker that can widen its own authorization list is a Worker
whose authorization list is decorative. The manual step is the gate.

The response is not stored anywhere and the key is not recoverable. Lose it and
mint another; remove the old hash.

## 8. The loop on/off checklist

The nightly loop is off by default and stays off until every line here is true.
Each item exists because of something that went wrong when it was not checked.

### Before switching it on

- [ ] **A scores document exists for every project on the roster**, with an
      Anchors section and a Secondary section. A project without one is refused;
      there is no opt-in by existing.
- [ ] **Every anchor block is pinned.** `improve_status` reports `anchor_pinned`
      per project. An unpinned project refuses every run.
- [ ] **Every declared secondary metric is one something actually reports.** Two
      were declared everywhere and emitted as null on every run for weeks.
- [ ] **A hidden suite and its manifest are uploaded for every project**, and the
      suite has been measured passing against the current default branch. A suite
      that does not already pass reverts every attempt forever.
- [ ] **The manifest total matches the real case count.** A report claiming fewer
      tests than the manifest declares is refused, which is the defence against
      the cheapest attack: shrinking the suite rather than passing it.
- [ ] **The signing secret is set**, and each repository holds its own derived
      per-project key as a repository secret. A key leaking from one repository
      must not verify for another.
- [ ] **The scoring workflow is byte-identical across every repository** except
      the per-repository build job. Verify by hashing the shared section, not by
      reading it.
- [ ] **A shakedown dispatch has been run and answered.** Dispatch the scorer with
      the literal run id `shakedown`: the expected terminal answer is a refusal of
      the unknown run, which proves the signature verified end to end.
- [ ] **The budget caps are set** for CI minutes and model spend, and
      `improve_status` shows them.
- [ ] **No project is paused for a reason nobody has read.** A pause key has no
      expiry on purpose.

### Switching it on

```
improve_run(action: "mode", value: "subscription")   # a human session drives it
improve_run(action: "mode", value: "api")            # the Worker drives it
```

Start with the human-driven mode. It does everything except talk to a model: it
reads the scores, verifies the pin, picks the base commit and writes a signed task
document. Nothing is spent, and you get to read what it was going to do.

### Switching it off

```
improve_run(action: "mode", value: "off")
improve_run(action: "pause", namespace: "all", reason: "why")
```

`off` is also what an unset key, an unrecognised value or an unreadable store
mean. That default is load-bearing: without it, an unreadable configuration store
starts writing to every repository on the roster.

### After the first night

- [ ] Read the run summary and every attempt archive. They are written **before**
      the score arrives, so an attempt that was never scored still left a record.
- [ ] Check the audit log for the loop's actor. One query answers what it did.
- [ ] Look at the pull request. **Nothing is merged automatically**, and that is
      the human gate rather than an oversight.
