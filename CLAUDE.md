# Software Factory

We are building a **software factory**: an agent loop that picks up tickets from
GitHub issues, does the work, and ships the result back to GitHub. People build and
improve the loop. The loop builds the features.

This repo is the factory's home for the Software Factories training
(Contour Software × Jonas Club, Oct 2026). Track: QA. Only what is pushed to `main`
counts: files, issues, comments and commits.

## Progressive disclosure

Context is loaded in layers, so an agent reads only what the current task needs.

1. **This file** is always loaded. It holds the purpose, the rules and the index.
   It stays short and points elsewhere for detail.
2. **A project folder's own `CLAUDE.md`** is read only when working in that project.
   It holds that project's stack, commands, conventions and gotchas.
3. **Skills, docs and code** in `.claude/skills/` or a project's folders are opened
   only when a task calls for them.

Put detail at the lowest layer that needs it. If something here grows past a line
or two, move it down a layer and leave a pointer.

## Rules

- **One project per folder.** Each project lives in its own top-level folder with
  its own `CLAUDE.md`. Nothing project-specific goes in the repo root.
- **This file owns the index.** When you add, rename or remove a project, update
  the index below in the same commit.
- **Keep this file under 100 lines at all times.** Check with `wc -l CLAUDE.md`
  before committing. If it is too long, push detail down into project folders.
- **Tickets drive the work.** Tickets arrive as issues named `Ticket #N`. Handle
  them with the `factory-loop` skill. Builds go on a `ticket-<n>` branch and land
  on `main` through a pull request a human approves. Commits say `refs #3`.
- **Every stop auto-commits and pushes** via `.claude/hooks/on-stop.sh`, so never leave
  secrets or half-finished junk in the working tree.
- **Ground rules.** Training repo only: no Jonas or Contour code, and no real keys
  or secrets.

## Index

### Factory

| Path | What it is | Read when |
|---|---|---|
| `README.md` | Workshop overview, scoring and ground rules | Starting out or checking how work is scored |
| `CLAUDE.md` | This file: purpose, rules and the index | Always loaded |
| `.claude/skills/factory-loop/` | Works tickets: answers questions; builds go questions, approved plan, build on a branch, browser check with screenshots, PR reviewed by a human, squash merge. Never destructive | Processing tickets, by hand or with `/loop` |
| `.claude/skills/security-review/` | Free security review: npm audit, secrets, XSS sinks, scripts, DeepSec scan, triage. Runs on every build | Any security check |
| `.claude/skills/deepsec/` | Vercel DeepSec scanner: free scan anytime; paid AI review only with human approval | Deep vulnerability scans |
| `.deepsec/` | DeepSec workspace, pinned 2.3.10, local Claude login; `INFO.md` holds the threat model. Findings are git-ignored | Updating the threat model |
| `.mcp.json` | `chrome-isolated` browser server with a throwaway profile, for browser checks | Browser checks fail to start |
| `.claude/settings.json` | Stop hook: runs `on-stop.sh` | Changing hooks |
| `.claude/hooks/on-stop.sh` | On every stop: logs prompts, then commits and pushes all changes. Never force-pushes; skips likely secrets | Debugging auto-commit |
| `.claude/hooks/log-prompts.py` | Appends new session prompts to the prompt log | Debugging the prompt log |
| `.claude/logs/prompts.jsonl` | Prompt log, one JSON object per line; kept tracked by `.gitignore` | Reviewing what was asked |

### Projects

| Folder | What it is | Status |
|---|---|---|
| `todo/` | Todo app on IndexedDB: tasks, filters, due dates, tags, recurring tasks, priority, editing (Tickets #3-#6) | Done, 108 tests, 16/16 mutants killed |

## Adding a project

1. Create a top-level folder named in kebab-case, for example `quiz-app/`.
2. Add a `CLAUDE.md` inside it covering purpose, how to run and test, and conventions.
3. Add a row to the Projects table above.
4. Commit all three together and reference the ticket.
