import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// THE SOURCE WALK, ONCE (quality audit 1.1).
//
// Four scanners located the behaviour they guard by reading src/server.ts as a
// string: invariants, counts, limits and doc-meta. path-mutation already walked
// the whole directory, and it walked it for the right reason, recorded in that
// file: scanning one file makes the guard's scope an assumption about where the
// next offender will be written, and the defect it guards had already arrived
// three times in places nobody predicted.
//
// The narrow version had a second cost, and it is the one this batch exists to
// remove. server.ts is the only legal place to add a tool AND the only file the
// guards read, so the file cannot be split without blinding them: move a tool to
// src/tools/documents.ts and the operator-gate guard, the tool count and the
// bounded-argument guard all pass over a file that no longer contains what they
// check. Widening them first is what makes that split possible later.
//
// Everything reads through here so there is one definition of "the source", one
// vacuity guard, and one place to change when src/ grows a subdirectory.

const SRC_DIR = join(import.meta.dirname, "..", "src");

export interface SourceFile {
  name: string;
  text: string;
}

// A floor, not a count. It exists so a walk that silently returns nothing fails
// loudly instead of making every assertion downstream vacuously true, which is
// the failure mode this repo has been bitten by four times. It is deliberately
// well below the real file count so adding or removing a module is not a test
// edit; it only catches a walk that broke.
const MIN_SOURCE_FILES = 10;

export function sourceFiles(): SourceFile[] {
  const files = readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));
  if (files.length < MIN_SOURCE_FILES) {
    throw new Error(
      `the src/ walk found ${files.length} files, fewer than the ${MIN_SOURCE_FILES} floor. ` +
        `Either the directory moved or the walk is broken; every source guard that reads through here is now scanning nothing.`
    );
  }
  return files;
}

// Every source file concatenated, with a per-file banner so a match can be traced
// back. Use this for counts and presence checks; use sourceFiles() when a finding
// has to name the file it came from.
export function allSourceText(): string {
  return sourceFiles()
    .map((f) => `// ===== ${f.name} =====\n${f.text}`)
    .join("\n");
}

// The text of one named file. Kept so a scanner that genuinely is about one
// module (the consent dialog's own headers, say) can say so explicitly rather
// than searching everything and hoping.
export function sourceFile(name: string): string {
  const found = sourceFiles().find((f) => f.name === name);
  if (!found) throw new Error(`src/${name} not found by the source walk`);
  return found.text;
}
