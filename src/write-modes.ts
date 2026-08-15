// Body assembly for the write tool's four modes. Pure, so it can be tested
// without a database.
//
// Batch-two item 4. Before this existed, `write` took a full body and nothing
// else, so appending one line to a 32KB decisions.md meant retranscribing 32KB.
// That is the correlated-transcription risk and it fired twice on 2026-08-07.
// capsid/conventions.md answered it with a hand-run SQL splice, write gated,
// with the version snapshot and audit row preserved BY HAND. This module is what
// lets that convention narrow: the same anchored edit, with the invariants
// enforced by the write path rather than by the care of whoever wrote the script.
//
// Every mode returns the FULL new body. There is deliberately no second write
// path: a separate one is how a rule like "always snapshot the prior version"
// gets skipped for the new case.

export type WriteMode = "replace" | "append" | "patch" | "meta";

// What arrives from the wire: every field optional, every combination possible,
// because zod is deliberately loose there and a client can send anything.
export interface WriteRequest {
  mode: WriteMode;
  exists: boolean;
  priorBody: string | null;
  title?: string;
  body?: string;
  find?: string;
  replace_with?: string;
}

// WHAT ASSEMBLY IS ALLOWED TO SEE (quality audit 3.1).
//
// One flat interface with every field optional meant `{ mode: "patch", body }` and
// `{ mode: "replace" }` with no title both typechecked, so the assembly code had to
// re-establish by hand, at every branch, which fields it could trust. A
// discriminated union makes those states unconstructible instead: each mode
// carries exactly the fields it uses, and they are REQUIRED rather than optional.
//
// The union could not simply replace WriteRequest, and the reason is the point of
// the split. The refusals below ("mode 'meta' does not take body") exist because a
// CLIENT can send that combination. Had the union become the parameter type, the
// call site could no longer express the bad shape, those checks would be
// unreachable, and a client sending mode:'meta' with a body would have had it
// silently ignored rather than refused. So the wire keeps its loose type, one
// function narrows it, and everything after that point holds a shape that cannot
// be wrong.
export type AssembleInput =
  | { mode: "replace"; exists: boolean; priorBody: string | null; title: string; body: string }
  | { mode: "append"; exists: boolean; priorBody: string | null; body: string }
  | { mode: "meta"; exists: boolean; priorBody: string | null }
  | { mode: "patch"; exists: boolean; priorBody: string | null; find: string; replace_with: string };

export type AssembleResult = { body: string } | { error: string };

// The narrowing, and the only place a mode/field mismatch is refused. Error
// precedence is load-bearing and preserved exactly: replace is checked before the
// existence test, so creating a document reports the missing title rather than
// "cannot replace a document that does not exist", and every other mode reports
// the missing document first.
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

  // meta changes type, tags, status or title and leaves the body byte-identical.
  //
  // This mode is not a convenience. Without it, marking a task closed (batch-two
  // item 5) or correcting a mistyped document (item 7) means resupplying the
  // entire body, which for a 45KB decisions.md is the exact retranscription this
  // whole item exists to remove. A closure workflow that costs a full rewrite is
  // a closure workflow nobody uses.
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
  return { mode, exists, priorBody, find, replace_with };
}

// Assembly proper. Every field it reads is guaranteed present by the union, so
// there is no re-checking here and no way to reach a branch with the wrong ones.
export function assemble(input: AssembleInput): AssembleResult {
  if (input.mode === "replace") return { body: input.body };

  const current = input.priorBody ?? "";

  if (input.mode === "meta") return { body: current };

  if (input.mode === "append") {
    // Exactly one blank line between the stored body and the addition, whatever
    // trailing whitespace the stored body happens to carry and whatever leading
    // newline the caller sent. Without this, repeated appends either run
    // together or accumulate blank lines, and both are silent corruption of a
    // markdown document.
    return { body: `${current.replace(/\s*$/, "")}\n\n${input.body.replace(/^\s*\n/, "")}` };
  }

  const { find, replace_with } = input;

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

  // Spliced by index, NOT by String.replace (audit 2, F19). replace() with a
  // string pattern still reads the REPLACEMENT for $ substitution syntax, so a
  // replace_with carrying $&, $`, $' or $$ silently rewrote itself into the
  // matched text, the text before it, the text after it, or a bare $, and the
  // write reported success on the corrupted body. Prose hits this: any canon
  // fragment with a dollar amount followed by an apostrophe or an ampersand is a
  // live trigger. The anchor is already known to occur exactly once, so a slice
  // around indexOf is both simpler and incapable of interpreting anything.
  const at = current.indexOf(find);
  return { body: current.slice(0, at) + replace_with + current.slice(at + find.length) };
}

// The one entry point the write tool calls: narrow, then assemble. Kept as a
// single call so the handler cannot accidentally assemble without narrowing.
export function assembleBody(req: WriteRequest): AssembleResult {
  const input = narrowWrite(req);
  if ("error" in input) return input;
  return assemble(input);
}
