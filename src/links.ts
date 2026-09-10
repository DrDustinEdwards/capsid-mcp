import { nsName, pathProblem } from "./limits";

export const LINK_TYPES = ["governs", "references", "supersedes", "replaces", "depends-on"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

const isLinkType = (value: unknown): value is LinkType =>
  typeof value === "string" && (LINK_TYPES as readonly string[]).includes(value);

export interface LinkEdge {
  type: LinkType;
  to_ns: string;
  to_path: string;
}

// Endpoints are document keys. Same pathProblem and nsName as the write path.
// An empty array clears outgoing edges. to_ns defaults to the writing namespace.
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
