// Server-side punctuation normalization.
//
// The no-em-dash rule is enforced at the Claude Code layer by a hook, but any
// document written straight into D1 through the MCP write tool bypasses that
// hook (claude.ai, agents, direct API). This runs in the Worker on every write
// so no document can store an em dash regardless of which client wrote it.
//
// Prose separators collapse to a comma-space. Titles and markdown heading lines
// use a spaced hyphen instead, so a doc's H1 and its title field read the same
// ("capsid - core", not "capsid, core"). Numeric en-dash ranges (2014-2018)
// become a plain hyphen; en dashes used as em dashes collapse like em dashes.

const EM_OR_BAR = /\s*[—―]\s*/g; // em dash (U+2014), horizontal bar (U+2015)
const EN_RANGE = /(\d)\s*–\s*(\d)/g; // numeric en-dash range -> hyphen
const EN_DASH = /\s*–\s*/g; // remaining en dash used as an em dash
const HEADING = /^\s{0,3}#{1,6}\s/;

function applyDashes(text: string, sep: string): string {
  return text.replace(EN_RANGE, "$1-$2").replace(EM_OR_BAR, sep).replace(EN_DASH, sep);
}

// mode "title" uses a spaced hyphen throughout. mode "prose" uses a comma-space,
// except markdown heading lines, which take the spaced hyphen so a body's
// heading matches the title field.
export function normalizeDashes(text: string, mode: "prose" | "title" = "prose"): string {
  if (!text) return text;
  if (mode === "title") return applyDashes(text, " - ");
  return text
    .split("\n")
    .map((line) => applyDashes(line, HEADING.test(line) ? " - " : ", "))
    .join("\n");
}

// True if the text still holds any em dash, horizontal bar, or en dash. Used by
// checks and the one-time cleanup verification; the write path just normalizes.
export function hasWideDash(text: string): boolean {
  return /[–—―]/.test(text ?? "");
}
