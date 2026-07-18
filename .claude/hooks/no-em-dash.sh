#!/usr/bin/env bash
# PreToolUse hook: blocks any Write or Edit whose incoming content carries an em
# or en dash. Canon: capsid/conventions.md.
#
# PreToolUse plus exit 2 is the only combination that blocks the tool call.
# PostToolUse fires after the write has landed and cannot undo it.
#
# Parser: python3 (ships with the Xcode Command Line Tools; jq does not ship on
# macOS). If python3 is missing the hook exits 1, a loud non-blocking error in
# the transcript, rather than silently passing. An enforcement hook that fails
# open in silence is worse than no hook: the first draft of this script used jq
# and exited 0 on a real em dash on any box without jq. Functionally tested
# 2026-07-16: em dash in Write content blocks (2), en dash in Edit new_string
# blocks (2), clean content passes (0), an Edit whose old_string removes a dash
# passes (0), missing fields pass (0), malformed JSON passes (0).
#
# Only content and new_string are checked, deliberately: old_string must be
# allowed to contain a dash, otherwise an edit that fixes one can never run.
# NOTE for this repo: the server-side normalizer in src/normalize.ts covers D1
# document writes; this hook covers the repo's own source files.
set -uo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "no-em-dash hook: python3 not found; dash check NOT enforced" >&2
  exit 1
fi

result=$(python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input") or {}
text = "".join(str(ti.get(k) or "") for k in ("content", "new_string"))
if "\u2014" in text or "\u2013" in text:
    print(str(ti.get("file_path") or "this file"))
    sys.exit(3)
sys.exit(0)
')
rc=$?

if [ "$rc" -eq 3 ]; then
  {
    echo "Blocked: an em dash or en dash is present in the content for $result."
    echo "Canon (capsid/conventions.md): no em dashes anywhere, including code, copy, comments, and commit messages."
    echo "Use a comma, a colon, parentheses, or split the sentence. Then retry the write."
  } >&2
  exit 2
fi

exit 0
