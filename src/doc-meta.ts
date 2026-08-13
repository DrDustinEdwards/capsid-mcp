// The memory model's document types and statuses (capsid/schema.md). Both are
// validated on write so an off-schema value cannot silently escape the lint loop.
//
// The same hole has now been found twice, one field apart. First, docs stored as
// type "session" or "handoff" were invisible to gather and to the counts, which
// is why the type list is validated at all. Then 22 recova episodics stored as
// status "active" went invisible the same way, because the unconsolidated
// counter and the gather query both filtered on status = 'published'. Those two
// queries are archive-path-only now, so the archive/ prefix is the ONLY thing
// that takes a doc out of the lint loop, and status is validated here so a
// plausible-looking value cannot quietly invent a new one either.

export const DOC_TYPES = new Set([
  "core", "concept", "semantic", "note", "decision", "spec", "task", "protocol",
  "post", "episodic", "procedural", "source", "prompt", "reference",
]);

// The six statuses in live use. Status records a document's editorial state. It
// does NOT decide whether the lint loop can see the document.
//
// "closed" was added 2026-08-12 (batch-two item 5). Task closure had been
// unrepresentable: nothing distinguished a task still to do from one finished,
// so closure was written into bodies as prose and brief returned every
// non-archived task doc forever. Ruled a status value rather than a new column,
// and it needed NO migration: this column is TEXT with no CHECK constraint, so
// the vocabulary is exactly this set and nothing else.
//
// Closure is set GOING FORWARD. Existing documents keep the status they have,
// deliberately: backfilling would mean inventing an editorial judgement about
// work nobody reviewed.
export const DOC_STATUSES = new Set([
  "draft", "ready", "active", "published", "superseded", "closed",
]);

export function validateDocType(type: string): string | null {
  if (DOC_TYPES.has(type)) return null;
  return `unknown type '${type}'; valid types: ${[...DOC_TYPES].join(", ")}. Session logs and handoffs are 'episodic'.`;
}

export function validateDocStatus(status: string): string | null {
  if (DOC_STATUSES.has(status)) return null;
  return `unknown status '${status}'; valid statuses: ${[...DOC_STATUSES].join(", ")}. Status does not control lint visibility; only the archive/ path prefix does.`;
}
