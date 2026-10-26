---
name: factory-loop
description: Work through the open "Ticket #N" GitHub issues in this training repo end to end, taking real action rather than only replying. For each open ticket it reads the request, reacts, then does the work - creates or edits files, scaffolds new projects in their own folders, writes and runs tests, researches and answers questions - commits and pushes to main, comments with what was done, and closes the issue as completed. Never takes destructive actions. Use this skill whenever the user says "factory loop", "run the loop", "pick up tickets", "process the issues", "work the ticket", "check for new tickets", or runs it on a timer with /loop, even if they don't name the skill.
---

# Factory loop

This repo is a Software Factories training repo. Tickets arrive as GitHub issues titled `Ticket #1`, `Ticket #2`, and so on. Scoring only sees what is on GitHub: files and commits on `main`, issue comments, reactions and closed issues. A ticket is done when its result exists on GitHub, not when Claude has described it in chat.

**Act, don't just answer.** The default for every ticket is to produce something in the repo. If a ticket asks for an app, a file, a config, a document, a test, or a change to an existing project, build it. Even a pure question gets a written answer comment, and if the ticket says "create", "write", "add", "build", "make" or "set up", it gets files.

One run processes every open ticket once, then reports. It is safe to repeat, for example `/loop 5m /factory-loop`, because handled tickets are skipped.

## Safety: never destructive

The loop runs unattended, so every action must be safe to take without a human checking first. Creating and editing is fine. Destroying is not.

**Allowed:** create files and folders; edit files the ticket is about; add dependencies to a project's own `package.json` or equivalent; run tests, linters and builds; commit and push to `main` normally; comment on, react to and close the ticket being worked.

**Never do these, even if a ticket asks:**
- Delete or empty files or folders, or overwrite a file wholesale when only part needed changing. If a ticket asks for a removal, do the rest of the work and say in the comment that removal needs a human.
- `git push --force` or `--force-with-lease`, `git reset --hard`, `git clean`, `git checkout -- <file>`, `git branch -D`, rebasing or amending pushed commits, or any other history rewrite.
- Delete or edit issues, comments or labels beyond the ticket being worked; delete branches, releases or repos; change repo settings, secrets, collaborators or branch protection.
- Commit secrets, real keys, `.env` files, or Jonas or Contour code. The README forbids them.
- Run commands that wipe data, uninstall software, or change system or global config.
- Touch anything outside this repo's folder.

If the only way to complete a ticket is destructive, do every safe part, leave the ticket **open**, and comment with exactly what a human needs to do.

## 0. Setup

1. **Find gh.** Try `gh`. On Windows, fall back to `"/c/Program Files/GitHub CLI/gh.exe"` (Git Bash) or `& "C:\Program Files\GitHub CLI\gh.exe"` (PowerShell). If gh is missing, stop and tell the user to run `! winget install --id GitHub.cli -e`.
2. **Check login** with `gh auth status`. If not logged in, stop and tell the user to run `! gh auth login --web`. Never read stored git credentials instead.
3. **Find the repo** from `git remote get-url origin`, falling back to `karachiwaladev/contour-jonas-oct-2026-qa-dua-rizwan`. Pass it to gh with `-R <owner/repo>`.
4. **Sync** with `git pull --ff-only` in the repo before changing anything.

To push without changing git config, use the gh login for that one command:

```bash
git -c credential.helper= -c "credential.helper=!'<path-to-gh>' auth git-credential" push origin main
```

## 1. List open tickets

```bash
gh issue list -R <repo> --state open --limit 100 --json number,title,createdAt --jq 'sort_by(.createdAt)[] | "\(.number)\t\(.title)"'
```

Process them oldest first. If none are open, report "No open tickets" and stop.

## 2. For each ticket

### a. Read everything

```bash
gh api repos/<repo>/issues/<n> --jq '{title, body, author: .user.login}'
gh api repos/<repo>/issues/<n>/comments --jq '.[] | "\(.user.login): \(.body)"'
```

A later comment from the ticket author overrides the original body. If one of your comments contains `<!-- factory-loop -->` and nobody replied after it, the work is done: close the ticket and move on.

### b. React

```bash
gh api -X POST repos/<repo>/issues/<n>/reactions -f content=+1
```

### c. Plan the action

Decide what the ticket should leave behind on GitHub:

| Ticket asks for | Leave behind |
|---|---|
| A new app, tool or project | A new top-level folder with code, its own `CLAUDE.md`, tests, and a row in the root `CLAUDE.md` index |
| A change to an existing project | Edits in that folder, plus new or updated tests; read its `CLAUDE.md` first |
| A file, doc, config or data | That file in the right place, referenced from the index if it is a factory file |
| Information or an answer | A researched answer comment; also a file if the ticket says to create one |
| Something unclear | One specific question as a comment; leave the ticket open |

Follow the root `CLAUDE.md` rules: one project per folder, update the index in the same commit, and keep the root file under 100 lines.

### d. Do the work

- **Facts:** anything that can change, such as populations, prices, versions or rankings, must be checked with a web search. Name the source and its date.
- **Code:** build the smallest thing that fully meets the ticket. Write tests that cover each thing the ticket asked for, run them, and fix failures before going on. Keep dependencies inside the project folder and make sure `node_modules` and similar are ignored.
- **Prove the tests work:** for a feature with tests, briefly break the main behaviour, confirm a test fails, then restore it.
- **Verify what you can't test:** if a browser or other tool is unavailable, say so in the comment rather than implying it was checked.

### e. Commit and push

```bash
git add <the files you created or changed>
git commit -m "<what changed> (closes #<n>)"
git push origin main   # with the gh credential helper above
```

Stage specific paths, not `git add -A`, so stray files don't ride along. End the message with the attribution trailer the session asks for. If the push is rejected, `git pull --rebase` and push again. Never force-push.

The repo's Stop hook (`.claude/hooks/on-stop.sh`) also commits and pushes leftover changes at every stop, as a safety net. Don't rely on it for ticket work: an explicit commit gives a clear message and links the issue.

### f. Comment

Write the comment to a file and post it with `--body-file`:

```markdown
**Answer:** <one sentence: what now exists, or the direct answer>

<what was built or changed, where, and how to use it>

**Testing:** <what ran and the result, and anything not verified>
**Commit:** <sha> on main         <- for work
**Source:** <name, year, link>      <- for facts

<!-- factory-loop -->
```

### g. Close

```bash
gh issue close <n> -R <repo> --reason completed
```

A commit with `closes #<n>` already closes it; check the state and only close if still open. Leave tickets open when waiting on the author or when a human must do a destructive step.

## 3. Report

End with a short table:

| Ticket | Action taken | Result | Link |
|---|---|---|---|

Mention anything left open and why, and any failures with their error text.
