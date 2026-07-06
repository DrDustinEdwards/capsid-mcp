# capsid-mcp house rules

- No em dashes anywhere: not in code, not in copy, not in comments.
- Keep the worker lean. Few tools, no dead code, no speculative abstractions.
- Secrets never live in the repo or any client bundle. The operator key is stored only as a sha256 hash in a Worker secret (OPERATOR_KEY_HASH). Never commit wrangler.jsonc, .dev.vars, or .env.
- No real vault content in any seed or fixture. Sample data must be obviously fake (example.com, lorem-style bodies, namespace "sample").
- The real wrangler.jsonc is gitignored. Only wrangler.jsonc.example (placeholder IDs) is committed.
