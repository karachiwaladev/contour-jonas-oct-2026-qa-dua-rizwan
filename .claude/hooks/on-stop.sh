#!/usr/bin/env bash
# Stop hook for the software factory. Runs every time Claude stops:
#   1. Logs new prompts to .claude/logs/prompts.jsonl (log-prompts.py).
#   2. Commits every change in the repo and pushes the current branch.
#
# Safety rules (non-destructive by design):
#   - Never force-pushes, never resets, never deletes branches or files.
#   - Only rebases local commits that were never pushed, and aborts on conflict.
#   - Refuses to commit likely secrets (.env, private keys, tokens) and leaves
#     them unstaged with a warning instead.
#   - Does nothing mid-merge or mid-rebase, or on a detached HEAD.
#   - Never blocks Claude: always exits 0 and reports through systemMessage.
#
# Usage:
#   on-stop.sh                       repo = $CLAUDE_PROJECT_DIR (project-level hook)
#   on-stop.sh --repo DIR --only-from DIR
#                                    user-level hook: act on DIR only when the
#                                    session's project dir is exactly --only-from

set -u

REPO="${CLAUDE_PROJECT_DIR:-}"
ONLY_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --only-from) ONLY_FROM="$2"; shift 2 ;;
    *) shift ;;
  esac
done

norm() { # lowercase, forward slashes, no trailing slash
  local p="$1"
  command -v cygpath >/dev/null 2>&1 && p="$(cygpath -m "$p" 2>/dev/null || echo "$p")"
  p="${p//\\//}"; p="${p%/}"
  printf '%s' "$p" | tr '[:upper:]' '[:lower:]'
}

say() { # JSON systemMessage shown to the user
  python -c 'import json,sys; print(json.dumps({"systemMessage": sys.argv[1]}))' "$1" 2>/dev/null
}

PAYLOAD="$(cat)"

if [ -n "$ONLY_FROM" ] && [ "$(norm "${CLAUDE_PROJECT_DIR:-}")" != "$(norm "$ONLY_FROM")" ]; then
  exit 0
fi
[ -n "$REPO" ] && cd "$REPO" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
cd "$(git rev-parse --show-toplevel)" || exit 0

# 1. Prompt log (always into this repo's log).
if [ -f .claude/hooks/log-prompts.py ]; then
  printf '%s' "$PAYLOAD" | CLAUDE_PROJECT_DIR="$PWD" PROMPT_LOG_FILE="" python .claude/hooks/log-prompts.py 2>/dev/null || true
fi

# 2. Commit and push.
GITDIR="$(git rev-parse --git-dir)"
if [ -e "$GITDIR/MERGE_HEAD" ] || [ -d "$GITDIR/rebase-merge" ] || [ -d "$GITDIR/rebase-apply" ]; then
  say "Auto-commit skipped: a merge or rebase is in progress."; exit 0
fi
BRANCH="$(git symbolic-ref --quiet --short HEAD)" || { say "Auto-commit skipped: detached HEAD."; exit 0; }

# Push through the GitHub CLI login without changing any git config.
GH="$(command -v gh 2>/dev/null || true)"
[ -z "$GH" ] && [ -x "/c/Program Files/GitHub CLI/gh.exe" ] && GH="/c/Program Files/GitHub CLI/gh.exe"
gitp() {
  if [ -n "$GH" ]; then
    git -c credential.helper= -c "credential.helper=!'$GH' auth git-credential" "$@"
  else
    git "$@"
  fi
}

git add -A

# Secret guard: unstage anything that looks like a credential.
BLOCKED=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$(basename "$f")" in
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa|id_ed25519|*.keystore) BLOCKED="$BLOCKED $f"; continue ;;
  esac
  if git diff --cached -U0 -- "$f" | grep -Eq '^\+.*(-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|xox[bpas]-[A-Za-z0-9-]{10,})'; then
    BLOCKED="$BLOCKED $f"
  fi
done < <(git diff --cached --name-only --diff-filter=AM)
if [ -n "$BLOCKED" ]; then
  # shellcheck disable=SC2086
  git reset -q -- $BLOCKED
  WARN="Auto-commit left out possible secrets:$BLOCKED. Add them to .gitignore or remove the secret."
fi

COMMITTED=""
if ! git diff --cached --quiet; then
  FILES="$(git diff --cached --name-only)"
  N="$(printf '%s\n' "$FILES" | grep -c .)"
  LIST="$(printf '%s\n' "$FILES" | head -5 | paste -sd ',' - | sed 's/,/, /g')"
  [ "$N" -gt 5 ] && LIST="$LIST, and $((N - 5)) more"
  MSG="$(printf 'Auto-commit on stop: %s file(s)\n\n%s\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' "$N" "$LIST")"
  if git commit -q -m "$MSG"; then
    COMMITTED="$(git rev-parse --short HEAD)"
  else
    say "Auto-commit failed: git commit returned an error."; exit 0
  fi
fi

# Push if anything local is ahead of the remote (also retries earlier failed pushes).
git remote get-url origin >/dev/null 2>&1 || { [ -n "$COMMITTED" ] && say "Committed $COMMITTED; no origin remote to push to."; exit 0; }
gitp fetch -q origin "$BRANCH" 2>/dev/null
if git rev-parse --verify -q "origin/$BRANCH" >/dev/null; then
  AHEAD="$(git rev-list --count "origin/$BRANCH..HEAD")"
else
  AHEAD=1 # new branch
fi
if [ "$AHEAD" = "0" ]; then
  [ -n "${WARN:-}" ] && say "$WARN"
  exit 0
fi

if ! OUT="$(gitp push -q origin "$BRANCH" 2>&1)"; then
  # Remote moved on: replay only our unpushed commits on top, never force.
  if gitp pull -q --rebase origin "$BRANCH" >/dev/null 2>&1; then
    if ! OUT="$(gitp push -q origin "$BRANCH" 2>&1)"; then
      say "Auto-push failed; commits are kept locally and nothing was overwritten. $(printf '%s' "$OUT" | grep -E '^(error|fatal|remote):' | head -1)"
      exit 0
    fi
  else
    git rebase --abort >/dev/null 2>&1
    say "Auto-push stopped: origin/$BRANCH has changes that conflict with yours. Your commit${COMMITTED:+ $COMMITTED} is kept locally and nothing was overwritten. Pull and resolve the conflict, then the next stop will push."
    exit 0
  fi
fi

HEAD_SHA="$(git rev-parse --short HEAD)"
say "Auto-committed and pushed $HEAD_SHA to $BRANCH.${WARN:+ $WARN}"
exit 0
