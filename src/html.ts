// HTML escaping, once. Two surfaces render HTML from stored values now (the OAuth
// consent dialog and the console), and a second copy of this function is the copy
// somebody forgets to widen.
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
