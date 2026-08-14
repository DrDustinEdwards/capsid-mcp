#!/usr/bin/env bash
# PreToolUse hook on Bash: blocks unscoped git adds (git add -A / --all / .).
# Canon: capsid/conventions.md, scoped commits with explicit named paths only.
#
# PreToolUse plus exit 2 is the only combination that blocks the tool call, and
# jq is not guaranteed on macOS, so the check is written in Python.
#
# Token-based, so paths that merely START with a dot (.claude/settings.json)
# pass; only the bare tokens -A, --all, . and ./ block.
#
# CANONICAL COPY, ruled 2026-08-16. Two properties define it, and neither is
# negotiable without a new ruling.
#
# FAILS CLOSED. The interpreter is probed by RUNNING candidates, not by
# command -v, because on Windows the bare name python3 resolves to the Microsoft
# Store stub, which satisfies command -v, prints an install notice and exits 49.
# stdin is decoded from sys.stdin.buffer as UTF-8 rather than trusting the text
# layer, which is cp1252 on Windows. CONTRACT, matching no-em-dash.sh exactly:
# checker exit 3 blocks, exit 0 passes, EVERY other outcome blocks and names the
# code. Before 2026-08-11 none of that held here: a missing interpreter exited 1,
# which does not block a tool call, and invalid JSON and any unexpected checker
# exit both fell through to 0.
#
# WHOLE-STRING MATCHING. The scan reads the entire command string. A variant
# anchoring the match to command position was tried in capsid-mcp (19554e1) and
# is REJECTED as of 2026-08-16: it removed one false positive and let three real
# bypasses through, each measured staging every file in a throwaway repo.
# "if true; then git add -A; fi", "env FOO=1 git add -A", and a backslash
# newline continuation all passed the narrowed matcher and are blocked by this
# one.
#
# KNOWN AND ACCEPTED FALSE POSITIVE, measured 2026-08-16 rather than assumed: it
# fires on UNQUOTED adjacency only, such as the rule written out in a heredoc
# body. A QUOTED mention passes, because the closing quote glues to the token
# and defeats the equality test, so a commit message quoting the rule inside
# double quotes is not blocked. For the cases that do fire the fix is to REWORD,
# not to loosen the matcher: parsing shell well enough to tell a heredoc from an
# argument is not something a guard should attempt, and for a blocking safety
# hook a false positive costs a rewording while a false negative costs the thing
# the hook exists to prevent. It fired on the very commit that landed the
# hardening (bb63828).
#
# KNOWN GAP, recorded and not fixed here: the check is token EQUALITY against
# four literal spellings, so a quoted flag, bundled short options, a subshell,
# and the repo-root pathspec all stage everything and are NOT blocked. Widening
# that tuple is a separate ruling.
#
# Verified 2026-08-11 by planting all three arms, and re-verified 2026-08-16
# against this canonical file before it landed anywhere. The older note
# "Functionally tested 2026-07-17: 10/10 cases" is RETIRED: it covered token
# matching only, predates every fail-open finding above, and never exercised
# them.
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
for m in re.finditer(r"git\s+add\s+([^|;&]*)", cmd):
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
      echo "Run git diff on each path first: a named path is not a scoped change if the file carries edits you did not write."
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
