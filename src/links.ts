// Typed, directional edges between documents (item 6, the ontology layer).
// The vocabulary is deliberately tiny and closed; edges are asserted like
// decisions, never bulk extracted. document_links is the queryable truth.

export const LINK_TYPES = new Set(["governs", "references", "supersedes", "replaces", "depends-on"]);

export interface LinkEdge {
  type: string;
  to_ns: string;
  to_path: string;
}

// Parse the write tool's `links` param: a JSON array of { type, to_path, to_ns? }.
// to_ns defaults to the writing document's namespace. Returns the normalized
// edges or a caller-facing error string. An empty array is valid and clears the
// document's outgoing edges.
export function parseLinks(linksJson: string, fromNs: string): { edges: LinkEdge[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(linksJson);
  } catch (err) {
    return { error: `invalid links JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(parsed)) {
    return { error: "links must be a JSON array of { type, to_path, to_ns? } edges (use [] to clear)" };
  }
  const edges: LinkEdge[] = [];
  for (const e of parsed) {
    if (!e || typeof e.type !== "string" || !LINK_TYPES.has(e.type)) {
      return { error: `each link needs a type in ${[...LINK_TYPES].join(", ")} (got ${JSON.stringify(e)})` };
    }
    if (typeof e.to_path !== "string" || !e.to_path.trim()) {
      return { error: `each link needs a to_path (got ${JSON.stringify(e)})` };
    }
    const to_ns = typeof e.to_ns === "string" && e.to_ns.trim() ? e.to_ns.trim() : fromNs;
    edges.push({ type: e.type, to_ns, to_path: e.to_path.trim() });
  }
  return { edges };
}
