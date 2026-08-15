// Typed, directional edges between documents (item 6, the ontology layer).
// The vocabulary is deliberately tiny and closed; edges are asserted like
// decisions, never bulk extracted. document_links is the queryable truth.

import { nsName, pathProblem } from "./limits";

// The closed set, as a TYPE and not only as a runtime guard (quality audit 3.5).
// LinkEdge.type used to be `string`, so every consumer of a parsed edge had to
// take on faith that the runtime check upstream had happened. Derived from the
// same array the check uses, so the two cannot disagree.
export const LINK_TYPES = ["governs", "references", "supersedes", "replaces", "depends-on"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

const isLinkType = (value: unknown): value is LinkType =>
  typeof value === "string" && (LINK_TYPES as readonly string[]).includes(value);

export interface LinkEdge {
  type: LinkType;
  to_ns: string;
  to_path: string;
}

// AN EDGE ENDPOINT IS A DOCUMENT KEY. RULED 2026-08-17 (quality audit 3.6).
//
// The question was real: `write` refused a path containing '..' while an edge to
// '../x' stored fine, because this function never used the path grammar. A comment
// on the dangling-edge warning in server.ts offered the looseness as deliberate,
// on the grounds that edges "may also address repo files rather than Capsid
// documents". Ruled the other way, and the deciding argument is that the loose
// reading was never IMPLEMENTABLE rather than merely unused:
//
//   - An edge is (to_ns, to_path), and to_ns is a NAMESPACE. Addressing a repo
//     file needs a repo selector and a ref, which an edge has nowhere to put. A
//     namespace can map to several repos, so even "the namespace's repo" does not
//     name one.
//   - Every consumer already treats the pair as a document key: backlinks and
//     gather's dangling-edge report both JOIN documents ON (to_ns, to_path), and
//     `move` repoints edges when a document is renamed. A repo path would be
//     reported dangling forever and silently rewritten by an unrelated rename.
//   - Measured before enforcing, live, 2026-08-17: all 96 edges resolve to real
//     documents. Zero carry '..', zero are absolute, zero are not .md. The loose
//     reading has no users to protect.
//
// So the grammar is applied here, in the ONE function that admits an edge, using
// the SAME pathProblem and nsName the write path uses. There is no second grammar.
//
// BEHAVIOUR CHANGE, named: a write whose links carry a traversal, an absolute path
// or an over-long path is now refused instead of stored. It refuses at parse time,
// before anything is written, and no live edge is affected.

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
    if (!e || !isLinkType(e.type)) {
      return { error: `each link needs a type in ${LINK_TYPES.join(", ")} (got ${JSON.stringify(e)})` };
    }
    if (typeof e.to_path !== "string" || !e.to_path.trim()) {
      return { error: `each link needs a to_path (got ${JSON.stringify(e)})` };
    }
    const to_path = e.to_path.trim();
    const problem = pathProblem(to_path);
    if (problem) {
      return { error: `link to_path ${JSON.stringify(to_path)} is not a document path: ${problem}` };
    }
    const to_ns = typeof e.to_ns === "string" && e.to_ns.trim() ? e.to_ns.trim() : fromNs;
    if (!nsName.safeParse(to_ns).success) {
      return { error: `link to_ns ${JSON.stringify(to_ns)} is not a namespace name` };
    }
    edges.push({ type: e.type, to_ns, to_path });
  }
  return { edges };
}
