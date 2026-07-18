#!/usr/bin/env bash
# PreToolUse hook on Bash: blocks unscoped git adds (git add -A / --all / .).
# Canon: capsid/conventions.md, scoped commits with explicit named paths only.
# python3 + exit 2, same pattern and rationale as no-em-dash.sh: PreToolUse exit 2
# is the only combination that blocks, and jq is not guaranteed on macOS.
# Token-based check so paths that merely START with a dot (.claude/settings.json)
# pass; only the bare tokens -A, --all, ., ./ block.
# Functionally tested 2026-07-17: 10/10 cases.
set -uo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "scoped-git-add hook: python3 not found; check NOT enforced" >&2
  exit 1
fi

python3 -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cmd = str((d.get("tool_input") or {}).get("command") or "")
for m in re.finditer(r"git\s+add\s+([^|;&]*)", cmd):
    toks = m.group(1).split()
    if any(t in ("-A", "--all", ".", "./") for t in toks):
        sys.exit(3)
sys.exit(0)
'
rc=$?

if [ "$rc" -eq 3 ]; then
  {
    echo "Blocked: unscoped git add (-A, --all, or .)."
    echo "Canon (capsid/conventions.md): scoped commits only. git add the named paths you changed."
  } >&2
  exit 2
fi

exit 0
