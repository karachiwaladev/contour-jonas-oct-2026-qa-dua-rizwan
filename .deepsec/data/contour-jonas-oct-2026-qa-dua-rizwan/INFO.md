# contour-jonas-oct-2026-qa-dua-rizwan

## What this codebase does

A "software factory" training repo: an agent loop picks up GitHub issues and
builds the work. The main app is `todo/`, a client-only todo app in plain
HTML, CSS and JavaScript, with no build step and no server. Tasks, due dates,
tags and recurrence live in the browser's IndexedDB. Factory tooling is under
`.claude/`: a Bash stop hook that auto-commits and pushes, and a Python
prompt logger.

## Auth shape

There is no authentication and no backend. The todo app trusts only its own
origin's IndexedDB. The factory pushes to GitHub through the `gh` CLI login
passed as a one-off `credential.helper`, never stored in git config.

## Threat model

1. **XSS in `todo/`.** Task titles and tags are user input rendered into the
   DOM. `app.js` must use `textContent`, never `innerHTML`, `insertAdjacentHTML`
   or attribute strings built from user data.
2. **Secrets pushed to a public repo.** `.claude/hooks/on-stop.sh` runs
   `git add -A` and pushes on every stop. Its secret guard and `.gitignore`
   are the only barrier.
3. **Command injection in hooks.** `on-stop.sh` and `log-prompts.py` read hook
   JSON from stdin and file paths. Unquoted expansion or `eval` of that data
   would be exploitable.
4. **Prompt log leakage.** `.claude/logs/prompts.jsonl` is committed and
   public, so anything typed into a session is published.

## Project-specific patterns to flag

- DOM writes in `todo/app.js` that use `innerHTML` or set `href`/`src` from task
  data.
- In `on-stop.sh`: unquoted `$VAR` in git commands, `eval`, staging paths
  outside the repo, or bypassing the secret guard (`BLOCKED`).
- Any `git push --force`, `reset --hard` or history rewrite in hooks or skills.
- `log-prompts.py` writing anywhere other than `.claude/logs/` or the
  `PROMPT_LOG_FILE` path.

## Known false-positives

- `todo/tests/ui.test.js` deliberately adds a task titled
  `<img src=x onerror=...>` to prove it renders as text. That's a test payload.
- `todo/tests/*` and `todo/node_modules/` are test-only or third-party code.
- `on-stop.sh` uses `git reset -q -- <files>` only to unstage suspected secrets.
  That isn't destructive.
- Regexes like `ghp_[A-Za-z0-9]{36}` in `on-stop.sh` are detection patterns, not
  real tokens.
