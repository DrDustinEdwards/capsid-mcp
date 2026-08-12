#!/usr/bin/env bash
# PreToolUse hook: blocks any Write or Edit whose incoming content carries an em
# or en dash. Canon: capsid/conventions.md.
#
# PreToolUse plus exit 2 is the only combination that blocks the tool call.
# PostToolUse fires after the write has landed and cannot undo it.
#
# FAILS CLOSED (2026-07-27). Contract: checker exit 3 blocks, exit 0 passes,
# EVERY other outcome blocks and names the code. The previous version fell
# through to exit 0 on any interpreter problem and so enforced nothing on the
# Windows host for an unknown period. Two independent causes, both fixed here:
#   1. "python3" resolved to the Microsoft Store stub, which satisfies
#      command -v, prints an install notice, and exits 49. The old guard used
#      command -v, so it never fired, and 49 fell through to exit 0.
#   2. Even with a real interpreter, sys.stdin.encoding is cp1252 on Windows,
#      so UTF-8 em dash bytes decoded to mojibake and the U+2014 test was False.
#
# The interpreter is therefore probed by RUNNING it, not by command -v, and
# stdin is decoded from sys.stdin.buffer as UTF-8 rather than trusting the text
# layer. Candidates in order: python3, python, py (the Windows launcher). The
# first one that echoes the probe token wins.
#
# The dash characters are written as \u escapes, never literally, so that the
# script stays clean under its own rule and cannot be broken by the source
# encoding of the -c argument.
#
# Three fields are checked: content and new_string (Write and Edit), and command
# (Bash). old_string is deliberately NOT checked: it must be allowed to contain a
# dash, otherwise an edit that fixes one can never run. Valid JSON with none of
# the checked fields present is a clean pass, not an error.
#
# BASH WAS ADDED 2026-08-12 (batch-two item 6). It was the third enforcement site
# and the only one still open. The rule has three sites, not two: the D1 write
# path normalizes wide dashes server-side, this hook covered Write and Edit, and
# Bash was matched only by scoped-git-add.sh. So `git commit -m` carrying a wide
# dash in the message, and any heredoc writing a file, went straight through.
# Both are squarely in scope of the canon rule, which names commit messages
# explicitly.
#
# The WHOLE command string is checked, with no carve-out for a command that means
# to search for a dash. Where a shell command genuinely needs the literal
# character, write it as an ANSI-C quoted escape, a dollar sign followed by the
# backslash-u form in single quotes, exactly as source code writes \uXXXX under
# the same rule. A carve-out is what let this rule rot at the other two sites.
#
# Still NOT covered, and this is a fourth site rather than a gap in this hook:
# capsid's own write_repo_file tool passes repo content through verbatim, so a
# wide dash can reach a repo that way without touching Write, Edit or Bash. That
# is recorded in capsid-mcp/CLAUDE.md and is how em dashes reached foxhound's
# docs copies.
# Notes carried forward from the repo-local copies that had diverged, so this
# file can stay byte identical everywhere:
#   Where a repo also runs a server-side normalizer (capsid-mcp's
#   src/normalize.ts), that covers D1 document writes; this hook covers the
#   repo's own source files. The two are separate paths and both are needed.
#   The one standing canon exception, never edit already-migrated post or
#   episode content in D1 to satisfy the dash rule, does not conflict with this
#   hook: that content is written by admin tooling, not by Write or Edit.
#
set -uo pipefail

block() {
  echo "$1" >&2
  exit 2
}

PY=""
for cand in python3 python py; do
  command -v "$cand" >/dev/null 2>&1 || continue
  if [ "$("$cand" -c 'print("hookprobe")' 2>/dev/null)" = "hookprobe" ]; then
    PY="$cand"
    break
  fi
done

if [ -z "$PY" ]; then
  block "no-em-dash hook: no working Python found (tried python3, python, py). On Windows the bare name python3 is often the Microsoft Store stub, which is not an interpreter. The dash check could not run, so this write is BLOCKED rather than passed silently. Put a real Python on PATH."
fi

result=$("$PY" -c '
import json, sys
raw = sys.stdin.buffer.read().decode("utf-8", "replace")
try:
    d = json.loads(raw)
except Exception:
    sys.exit(4)
ti = d.get("tool_input") or {}
text = "".join(str(ti.get(k) or "") for k in ("content", "new_string", "command"))
if "\u2014" in text or "\u2013" in text:
    label = ti.get("file_path")
    if not label:
        label = "the Bash command" if ti.get("command") else "this file"
    print(str(label))
    sys.exit(3)
sys.exit(0)
')
rc=$?

case "$rc" in
  0)
    exit 0
    ;;
  3)
    {
      echo "Blocked: an em dash or en dash is present in the content for $result."
      echo "Canon (capsid/conventions.md): no em dashes anywhere, including code, copy, comments, and commit messages."
      echo "Use a comma, a colon, parentheses, or split the sentence. Then retry the write."
      echo "If this is a Bash command that must carry the literal character (a search, a normalizer), write it as an ANSI-C quoted escape instead: a dollar sign, then the backslash-u form in single quotes."
    } >&2
    exit 2
    ;;
  4)
    block "no-em-dash hook: the payload on stdin was not valid JSON, so the dash check could not run. Failing closed: this write is BLOCKED (checker exit 4)."
    ;;
  *)
    block "no-em-dash hook: the dash check exited with unexpected code $rc. Failing closed rather than passing silently, so this write is BLOCKED. Interpreter used: $PY."
    ;;
esac
