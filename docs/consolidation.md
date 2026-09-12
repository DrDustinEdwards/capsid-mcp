# Consolidation and destructive writes

The `lint` tool runs the wiki maintenance loop. The Worker never calls an LLM. The driving client does the reasoning with the ordinary read and write tools.

- `lint(namespace, mode: "gather")` returns a read-only packet: the namespace `core.md`, the compiled `concept` and `decision` documents, every un-archived `episodic` and `source` document, and the schema and conventions.
- `lint(namespace, mode: "finalize", consumed: [paths])` archives the consumed entries under an `archive/` prefix and writes one audit row. It moves and never deletes, and `gather` excludes `archive/`, so the loop is idempotent.

## Destructive writes need confirmation

`delete`, `move`, `restore`, `lint` finalize, and any `write` that would overwrite an existing document ask for confirmation first. When the client supports [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation), the server sends an elicitation request and proceeds only on an explicit accept. Most Streamable HTTP clients run stateless and cannot answer server-initiated requests, so the tool rejects. Re-run it with `confirm: true`. Creating a new document never needs confirmation.

Every delete and overwrite snapshots the prior row into `document_versions` first, whatever happened at the confirmation step.
