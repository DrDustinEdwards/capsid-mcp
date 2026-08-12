// Body assembly for the write tool's three modes. Pure, so it can be tested
// without a database.
//
// Batch-two item 4. Before this existed, `write` took a full body and nothing
// else, so appending one line to a 32KB decisions.md meant retranscribing 32KB.
// That is the correlated-transcription risk and it fired twice on 2026-08-07.
// capsid/conventions.md answered it with a hand-run SQL splice, operator gated,
// with the version snapshot and audit row preserved BY HAND. This module is what
// lets that convention narrow: the same anchored edit, with the invariants
// enforced by the write path rather than by the care of whoever wrote the script.
//
// Every mode returns the FULL new body. There is deliberately no second write
// path: a separate one is how a rule like "always snapshot the prior version"
// gets skipped for the new case.

export type WriteMode = "replace" | "append" | "patch";

export interface AssembleInput {
  mode: WriteMode;
  exists: boolean;
  priorBody: string | null;
  title?: string;
  body?: string;
  find?: string;
  replace_with?: string;
}

export type AssembleResult = { body: string } | { error: string };

export function assembleBody(input: AssembleInput): AssembleResult {
  const { mode, exists, priorBody, title, body, find, replace_with } = input;

  if (mode === "replace") {
    if (title === undefined || body === undefined) {
      return {
        error:
          "mode 'replace' needs both title and body. Use mode 'append' to add to a document, or 'patch' to change part of one.",
      };
    }
    return { body };
  }

  if (!exists) {
    return { error: `cannot ${mode} a document that does not exist. Create it with mode 'replace' first.` };
  }

  const current = priorBody ?? "";

  if (mode === "append") {
    if (body === undefined) {
      return { error: "mode 'append' needs body: the text to add to the end of the document." };
    }
    if (find !== undefined || replace_with !== undefined) {
      return { error: "find and replace_with belong to mode 'patch', not 'append'." };
    }
    // Exactly one blank line between the stored body and the addition, whatever
    // trailing whitespace the stored body happens to carry and whatever leading
    // newline the caller sent. Without this, repeated appends either run
    // together or accumulate blank lines, and both are silent corruption of a
    // markdown document.
    return { body: `${current.replace(/\s*$/, "")}\n\n${body.replace(/^\s*\n/, "")}` };
  }

  // patch
  if (find === undefined || replace_with === undefined) {
    return { error: "mode 'patch' needs find and replace_with." };
  }
  if (body !== undefined) {
    return { error: "mode 'patch' takes find and replace_with, not body." };
  }
  if (find === "") {
    return { error: "mode 'patch' needs a non-empty find. An empty anchor matches everywhere." };
  }

  // The splice invariants, enforced here instead of by hand: anchor on text
  // measured to exist, and refuse a missed or ambiguous anchor rather than
  // silently corrupting the body. conventions.md asked for `instr(...) > 0` as a
  // guard on the UPDATE; this is that guard, plus the uniqueness check the SQL
  // version could not express.
  const occurrences = current.split(find).length - 1;
  if (occurrences === 0) {
    return {
      error:
        "patch anchor not found. Nothing was written. The find text must match the stored body exactly, including whitespace and line endings. CRLF versus LF is the usual cause; it silently defeated two plants on 2026-08-11.",
    };
  }
  if (occurrences > 1) {
    return {
      error: `patch anchor is ambiguous: it occurs ${occurrences} times. Nothing was written. Extend find until it is unique.`,
    };
  }

  return { body: current.replace(find, replace_with) };
}
