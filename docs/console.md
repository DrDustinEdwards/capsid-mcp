# The console

One page at `/console` that answers "what is the state of every namespace" without asking a chat. It renders what `improve_status` and `jobs` already compute.

- **Who gets in.** The GitHub admin session, and nothing else. The console rides the same GitHub OAuth app and the same single-admin check as the MCP flow, and turns the result into a signed cookie that lasts twelve hours. An operator key or an agent key gets a 403 that says so. Those authenticate to `/ops/mcp`. A login redirect would send a machine to GitHub.
- **What it shows.** A header with the deployed sha, the schema version, the backup age, the month's spend against its caps and the improve mode. Then one row per namespace: the pause reason if any, whether the anchor block is pinned, the last run's attempts, kept and reverted, the four job counts, the truth report's integrity percentage, and the driver agent's last_seen. A blocked job prints the exact command it is waiting on.
- **The agents panel** lists every credential with its kind, namespaces, flags held, last_seen and revoked state, beside what it did: jobs done, failed and blocked, pull requests opened and merged, and for a driver, its namespaces' attempts kept and reverted. A verified column carries the three numbers this Worker checked against GitHub itself, merge rate, CI green rate and median duration, kept separate from the counts the store wrote. A dash means there was nothing to divide by. Counts and rates only. No composite score.
- **Recent activity** is the last 50 audit rows, filterable by namespace and by actor.
- **Six controls**, each a POST with a CSRF token and a confirmation step that states what is about to happen before anything changes: pause, unpause, set the mode, resume a blocked job with the approval reason, mark a job failed, revoke an agent. Every one goes through the same function the MCP tool calls and writes its own audit row naming the person who clicked.
- **It never merges and it never mints.** Merging can start a CI deploy in two of these repos, so that stays with `manage_pr` behind a caller holding `can_merge`. Minting hands out a key, so that stays with the `agents` tool. Neither is in the console's action list, and a test asserts their absence.
- **`GET /console.json`** serves the same object the page renders, so a dashboard or a chat reads the state without scraping.

The page is self-contained: no scripts, no external fonts, one inline stylesheet, and a CSP that denies everything by default. Light and dark come from `prefers-color-scheme`.
