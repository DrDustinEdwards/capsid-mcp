#!/usr/bin/env bash
# PreToolUse hook on Bash: blocks unscoped git adds (git add -A / --all / .).
# Canon: capsid/conventions.md, scoped commits with explicit named paths only.
#
# PreToolUse plus exit 2 is the only combination that blocks the tool call.
#
# FAILS CLOSED (2026-08-09). Contract: checker exit 3 blocks, exit 0 passes,
# EVERY other outcome blocks and names the code. The previous version carried
# both of the defects that f4c30f9 fixed in the sibling no-em-dash.sh and that
# were never ported here:
#   1. The interpreter was probed with command -v, which the Microsoft Store
#      python3 stub satisfies without being an interpreter.
#   2. A missing interpreter exited 1, which does not block a PreToolUse, so the
#      check silently enforced nothing while printing that it had not run.
# Measured 2026-08-09 on the Windows host: with the interpreter hidden, the old
# script returned exit 1 on "git add -A" (fails open) where the sibling returned
# exit 2 (fails closed).
#
# The interpreter is therefore probed by RUNNING it, not by command -v.
# Candidates in order: python3, python, py (the Windows launcher). The first one
# that echoes the probe token wins.
#
# Token-based check so paths that merely START with a dot (.claude/settings.json)
# pass; only the bare tokens -A, --all, ., ./ block.
# Functionally tested 2026-07-17: 10/10 cases.
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
  block "scoped-git-add hook: no working Python found (tried python3, python, py). On Windows the bare name python3 is often the Microsoft Store stub, which is not an interpreter. The scoped-add check could not run, so this command is BLOCKED rather than passed silently. Put a real Python on PATH."
fi

"$PY" -c '
import json, re, sys
raw = sys.stdin.buffer.read().decode("utf-8", "replace")
try:
    d = json.loads(raw)
except Exception:
    sys.exit(4)
cmd = str((d.get("tool_input") or {}).get("command") or "")
# Only inspect segments that START a command: string start, or immediately
# after a shell separator. The previous version scanned the whole string with
# finditer, so prose that merely MENTIONED an add anywhere in a heredoc commit
# message tripped it. That fired on 2026-08-09 while committing this hook, on a
# message describing these very test cases.
for seg in re.split(r"[\n;&|]+", cmd):
    m = re.match(r"\s*git\s+add\s+(.*)$", seg)
    if not m:
        continue
    toks = m.group(1).split()
    if any(t in ("-A", "--all", ".", "./") for t in toks):
        sys.exit(3)
sys.exit(0)
'
rc=$?

case "$rc" in
  0)
    exit 0
    ;;
  3)
    {
      echo "Blocked: unscoped git add (-A, --all, or .)."
      echo "Canon (capsid/conventions.md): scoped commits only. git add the named paths you changed."
    } >&2
    exit 2
    ;;
  4)
    block "scoped-git-add hook: the payload on stdin was not valid JSON, so the scoped-add check could not run. Failing closed: this command is BLOCKED (checker exit 4)."
    ;;
  *)
    block "scoped-git-add hook: the scoped-add check exited with unexpected code $rc. Failing closed rather than passing silently, so this command is BLOCKED. Interpreter used: $PY."
    ;;
esac
