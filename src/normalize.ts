// Worker-side: the hook only sees Claude Code, not claude.ai or operator writes.
// Prose separators become ", "; titles and markdown headings become " - ".
// Numeric en-dash ranges (2014-2018) become a hyphen.

const EM_OR_BAR = /\s*[—―]\s*/g; // em dash (U+2014), horizontal bar (U+2015)
const EN_RANGE = /(\d)\s*–\s*(\d)/g; // numeric en-dash range -> hyphen
const EN_DASH = /\s*–\s*/g; // remaining en dash used as an em dash
const HEADING = /^\s{0,3}#{1,6}\s/;

function applyDashes(text: string, sep: string): string {
  return text.replace(EN_RANGE, "$1-$2").replace(EM_OR_BAR, sep).replace(EN_DASH, sep);
}

export function normalizeDashes(text: string, mode: "prose" | "title" = "prose"): string {
  if (!text) return text;
  if (mode === "title") return applyDashes(text, " - ");
  return text
    .split("\n")
    .map((line) => applyDashes(line, HEADING.test(line) ? " - " : ", "))
    .join("\n");
}

// Not dead: the holdout suite imports this. "No caller in src/ or test/" is not
// dead in this repo; confirm an export removal by scoring a branch, not grepping.
export function hasWideDash(text: string): boolean {
  return /[–—―]/.test(text ?? "");
}
