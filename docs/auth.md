# Auth model

Every caller resolves to an agent: a name, a set of scopes, and its own audit identity. There is one enforcement point, `checkScope` in `src/scope.ts`. The registrar wraps every tool registration before any tool module runs, so a tool is covered by existing, and `TOOL_GRANTS` states what each tool requires.

Scopes are five axes. `namespaces` and `repos` are a list or `*`. `tools` is an allow list or `*`. `grants` is read, or read and write. `flags` are the blast radius:

| flag | what it gates |
| --- | --- |
| `can_merge` | merging a pull request, which can trigger a deploy on a repo that deploys on push |
| `can_direct_write` | a `mode: "direct"` commit, which lands on a default branch with no review |
| `can_dispatch` | dispatching a workflow, which spends CI minutes and runs code with that repo's secrets in scope |
| `can_write_workflows` | writing under `.github/workflows/` |
| `can_touch_protected` | tests, CI, lint and compiler config, lockfiles, manifests, the agent steering layer, migrations |
| `money_paths` | a path naming a billing or payment surface |
| `can_comment_pr` | commenting on a pull request, the smallest write `manage_pr` makes. It is not `can_merge`. |

A new agent gets read on its named namespaces and no flags. Scopes are stored as JSON and the parse fails closed: a null, truncated or wrong-shaped column resolves to no namespaces, no tools, no grants and no flags.

### Roles

Roles are few and separated. Each one is a single capability, not a bundle. `scripts/mint-agents.mjs` holds them in two lists: `ROLES`, asked for by name, and `AGENTS`, the per-namespace bootstrap that holds the drivers and the seat. `node scripts/mint-agents.mjs --roles` prints a mint command for each entry in `ROLES`, which is the four below that are not a driver or the seat; the driver rows and the seat are minted by the same script's namespace path (`docs/bootstrap.md`). A test fails the build if any role names a second blast-radius flag.

| role | reads | writes | flag |
| --- | --- | --- | --- |
| `<ns>-driver` | its own namespace | its own namespace, pull requests only | none |
| `auditor` | every namespace and repo | nothing at all | none |
| `reviewer` | every namespace and repo | a comment on a pull request | `can_comment_pr` |
| `watcher` | every namespace | `jobs.post`, and no other job action | none |
| `seat` | every namespace | every namespace | `can_merge` |
| `site-seat` | `dustinedwards` | `dustinedwards` | `can_merge` |

The reviewer and the watcher both need the write grant, because commenting and posting a job both go through write tools. The tools axis keeps that from being a general write. An entry can name an action: `jobs.post` or `manage_pr.comment`. A list naming at least one action of a tool is narrowed to the actions it names. A bare tool name with no qualified sibling still means the whole tool, and `*` still allows everything, so no agent minted before this changes behaviour. The two tools whose action decides what they do (`jobs` and `lint`) pass the action to `checkScope` at the point where it is known, which is the same shape the grant check already uses.

The `agents` tool is admin only. An agent that could mint another could widen itself. `mint` returns a key once and stores only its sha256. `list` is the inventory, revoked rows included. `revoke` sets `revoked_at` rather than deleting, so rows an agent wrote still resolve to what it was allowed to do, while its key stops resolving immediately. `update_scopes` replaces named axes and leaves the rest.

Audit rows and `jobs.claimed_by` record a minted agent as `agent:<name>`.

Three kinds of caller resolve, in this order:

1. **A minted agent**, matched on the sha256 of its bearer token. Checked first, so a key that is both an agent and an operator entry gets the narrower authority.
2. **A legacy operator key**, until its hash is removed from `OPERATOR_KEY_HASH` by hand.
3. **The OAuth admin session**, the synthetic agent `admin` with every scope.

The operator hash is removed once every machine runs as its folder's driver agent and the admin OAuth session is the only wider credential. That is the intent, and it is the last step of the migration in `docs/bootstrap.md`, not something this document can report as done. Until `OPERATOR_KEY_HASH` is unset on the Worker the legacy path stays live: `src/auth.ts` reads the secret on every bearer request, and `src/agents.ts` gives a plain entry the admin grant, so a key in it can still mint agents. Whether it is still set is Worker state this repo cannot see. `npx wrangler secret list --name capsid` answers it, and prints names only.

Two gated endpoints:

1. **OAuth (`/mcp`)** for human clients. The client discovers the server via `.well-known`, registers dynamically, and goes through `/authorize` and a one-time approval screen to GitHub. On return the user is checked against `ADMIN_GITHUB_LOGIN`: the GitHub username, or the numeric user id (find it at `https://api.github.com/users/<login>`). Any other account gets a 403. The check runs again on every `/mcp` request. An admitted admin holds a full write grant.
2. **Agent and operator keys (`/ops/mcp`)** for agents and cron, gated by sha256-hashed bearer keys. An agent key resolves to its row. Failing that, `OPERATOR_KEY_HASH` holds comma-separated hashes: a plain entry is a write key, an entry prefixed `ro:` is read-only and is denied every tool `TOOL_GRANTS` marks write: write, delete, move, restore, register_namespace, update_namespace, repo writes, PR management, improve_run, agents, lint finalize, and every `jobs` action but `list`. Revoke by removing a hash; the others keep working. The OAuth library never sees this route.

Login and repo access use two different GitHub credentials: an OAuth App for login (OAuth Apps cannot mint installation tokens) and a GitHub App for repo access. Keep both.

`register_namespace` returns the command that mints the new namespace's driver agent, `node scripts/mint-agents.mjs --namespace <ns> --apply`. It does not mint it: minting is admin only, and `register_namespace` takes a plain write grant.
