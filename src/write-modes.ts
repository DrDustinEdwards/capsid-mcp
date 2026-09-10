export type WriteMode = "replace" | "append" | "patch" | "meta";

export interface WriteRequest {
  mode: WriteMode;
  exists: boolean;
  priorBody: string | null;
  title?: string;
  body?: string;
  find?: string;
  replace_with?: string;
}

// Wire type stays loose so a client sending a bad combination is refused rather
// than silently ignored. The union is what assembly is allowed to see.
export type AssembleInput =
  | { mode: "replace"; exists: boolean; priorBody: string | null; title: string; body: string }
  | { mode: "append"; exists: boolean; priorBody: string | null; body: string }
  | { mode: "meta"; exists: boolean; priorBody: string | null }
  | { mode: "patch"; exists: boolean; priorBody: string | null; find: string; replace_with: string };

export type AssembleResult = { body: string } | { error: string };

// Error precedence is load-bearing: replace is checked before the existence test.
export function narrowWrite(req: WriteRequest): AssembleInput | { error: string } {
  const { mode, exists, priorBody, title, body, find, replace_with } = req;

  if (mode === "replace") {
    if (title === undefined || body === undefined) {
      return {
        error:
          "mode 'replace' needs both title and body. Use mode 'append' to add to a document, or 'patch' to change part of one.",
      };
    }
    return { mode, exists, priorBody, title, body };
  }

  if (!exists) {
    return { error: `cannot ${mode} a document that does not exist. Create it with mode 'replace' first.` };
  }

  // meta leaves the body byte-identical.
  if (mode === "meta") {
    if (body !== undefined) {
      return { error: "mode 'meta' changes type, tags, status or title only, and does not take body." };
    }
    if (find !== undefined || replace_with !== undefined) {
      return { error: "find and replace_with belong to mode 'patch', not 'meta'." };
    }
    return { mode, exists, priorBody };
  }

  if (mode === "append") {
    if (body === undefined) {
      return { error: "mode 'append' needs body: the text to add to the end of the document." };
    }
    if (find !== undefined || replace_with !== undefined) {
      return { error: "find and replace_with belong to mode 'patch', not 'append'." };
    }
    return { mode, exists, priorBody, body };
  }

  if (find === undefined || replace_with === undefined) {
    return { error: "mode 'patch' needs find and replace_with." };
  }
  if (body !== undefined) {
    return { error: "mode 'patch' takes find and replace_with, not body." };
  }
  if (find === "") {
    return { error: "mode 'patch' needs a non-empty find. An empty anchor matches everywhere." };
  }
  return { mode, exists, priorBody, find, replace_with };
}

export function assemble(input: AssembleInput): AssembleResult {
  if (input.mode === "replace") return { body: input.body };

  const current = input.priorBody ?? "";

  if (input.mode === "meta") return { body: current };

  if (input.mode === "append") {
    // Exactly one blank line between stored body and addition.
    return { body: `${current.replace(/\s*$/, "")}\n\n${input.body.replace(/^\s*\n/, "")}` };
  }

  const { find, replace_with } = input;

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

  // Spliced by index, not String.replace: replace() still interprets $ in the
  // replacement.
  const at = current.indexOf(find);
  return { body: current.slice(0, at) + replace_with + current.slice(at + find.length) };
}

export function assembleBody(req: WriteRequest): AssembleResult {
  const input = narrowWrite(req);
  if ("error" in input) return input;
  return assemble(input);
}
