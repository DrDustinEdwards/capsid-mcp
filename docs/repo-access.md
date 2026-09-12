# Repo access

Capsid reaches your repositories through a dedicated GitHub App. The Worker mints a short-lived installation token (an RS256 JWT signed with Web Crypto, exchanged for an installation access token, cached in KV), so no long-lived token is stored. Repos resolve from the `namespaces` table.

A namespace can map to several repos, each with a label (for example `primary` and `legacy`). Every repo tool takes an optional `repo` parameter, a label or a mapped `owner/name`, defaulting to `primary`. An unmapped repo is rejected, so the namespace mapping is the authorization boundary.

- **Read**: `list_repo_tree`, `read_repo_file`, `search_code`, `repo_refs`, `repo_history`, `ci_status`
- **Write**: `write_repo_file`, `create_branch`, `delete_branch`, `open_pr`, `delete_repo_file`, `manage_pr`, `ci_dispatch`

`write_repo_file` defaults to `mode: "pr"` (commit to a new branch, open a pull request); `mode: "direct"` commits to the default branch and needs `can_direct_write`. `manage_pr` merges (squash by default) or closes a pull request, and deletes the head branch when it is safe.

`search_code` is a server-side tree walk (a recursive Git Trees listing, then bounded content scans), not GitHub's code search API, which returns empty results for private repositories under an App installation token. Use `path_prefix` to narrow large repos.
