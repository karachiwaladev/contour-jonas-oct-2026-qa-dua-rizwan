---
name: factory-loop
description: Work through the open "Ticket #N" GitHub issues in this training repo end to end, taking real action rather than only replying. Question tickets get a researched answer. Build tickets (a new project, or a feature in an existing one) go through clarifying questions, a plan the human approves, the build with tests, and verification in a real browser with chrome-devtools, with screenshots attached to the ticket. Commits and pushes to main and never takes destructive actions. Use this skill whenever the user says "factory loop", "run the loop", "pick up tickets", "process the issues", "work the ticket", "check for new tickets", or runs it on a timer with /loop, even if they don't name the skill.
---

# Factory loop

This repo is a Software Factories training repo. Tickets arrive as GitHub issues titled `Ticket #1`, `Ticket #2`, and so on. Scoring only sees what is on GitHub: files and commits on `main`, issue comments, reactions, labels and closed issues. A ticket is done when its result exists on GitHub, not when Claude has described it in chat.

One run looks at every open ticket once, moves each as far as it can go without a human, then reports. It is safe to repeat, for example `/loop 5m /factory-loop`: a ticket waiting on a human is skipped until a human replies.

## Safety: never destructive

The loop runs unattended, so every action must be safe without a human checking first.

**Allowed:** create files and folders; edit files the ticket is about; add dependencies inside a project folder; run tests, builds, local servers and a browser; commit and push to `main` normally; comment on, react to, label and close the ticket being worked.

**Never, even if a ticket asks:**
- Delete or empty files or folders, or overwrite a whole file when only part needed changing. Do the rest and tell a human in the comment.
- `git push --force`, `git reset --hard`, `git clean`, `git checkout -- <file>`, `git branch -D`, or any rewrite of pushed history.
- Delete or edit other issues, comments or labels; delete branches, releases or repos; change repo settings, secrets or collaborators.
- Commit secrets, real keys, `.env` files, or Jonas or Contour code.
- Kill processes you did not start, change global or system config, or touch anything outside this repo.

If a ticket can only be finished destructively, do every safe part, leave it **open**, and say exactly what a human must do.

## 0. Setup

1. **gh:** use `gh`, falling back to `"/c/Program Files/GitHub CLI/gh.exe"`. If missing, tell the user to run `! winget install --id GitHub.cli -e`. Check `gh auth status`; if logged out, tell them to run `! gh auth login --web`. Never read stored git credentials.
2. **Repo:** from `git remote get-url origin`, falling back to `karachiwaladev/contour-jonas-oct-2026-qa-dua-rizwan`. Pass `-R <owner/repo>` to gh.
3. **Sync:** `git pull --ff-only` before changing anything.
4. **Push** with the gh login, without changing git config:
   `git -c credential.helper= -c "credential.helper=!'<gh>' auth git-credential" push origin main`

## 1. List open tickets

```bash
gh issue list -R <repo> --state open --limit 100 --json number,title,createdAt --jq 'sort_by(.createdAt)[] | "\(.number)\t\(.title)"'
```

Oldest first. If none are open, report "No open tickets" and stop.

## 2. Read the ticket and find its stage

```bash
gh api repos/<repo>/issues/<n> --jq '{title, body, author: .user.login, labels: [.labels[].name]}'
gh api repos/<repo>/issues/<n>/comments --jq '.[] | {id, user: .user.login, created_at, body}'
```

The loop posts as the same GitHub account as the human, so tell comments apart by **marker**, not by author. A comment containing `<!-- factory-loop` is the loop's; any other comment is a **human reply**. Find the loop's latest marker:

| Latest loop marker | Human replied after it? | Stage |
|---|---|---|
| none | | **New:** react 👍, classify, start the right flow |
| `factory-loop:questions` | no | Waiting for answers: skip |
| `factory-loop:questions` | yes | **Plan** |
| `factory-loop:plan` | no | Waiting for approval: skip |
| `factory-loop:plan` | yes, approving | **Build** |
| `factory-loop:plan` | yes, asking for changes | **Plan** again, revised |
| `factory-loop:done`, or the older `factory-loop` | no | Close if still open, then skip |
| `factory-loop:done` | yes | Treat the reply as a follow-up request |
| `factory-loop:blocked` | no | Waiting on a human: skip |

Approval is any human reply that clearly agrees, such as "approved", "yes", "go ahead", "lgtm" or "ship it". If it is unclear whether a reply approves, ask in a short comment marked `factory-loop:plan` rather than guessing.

**Classify a new ticket:**
- **Question:** it only asks for information. Use the question flow.
- **Build:** it asks for a new project or app, or a feature or change in an existing project. Use the build flow.
- **Small factory change:** a doc, config or file outside any project, such as editing `CLAUDE.md`. Do it directly as in build step 3, without questions or browser checks.
- **Unclear:** ask one specific question with the `factory-loop:questions` marker.

## 3. Question flow

1. Research the answer. Anything that can change, such as populations, prices, versions or rankings, must come from a web search. Cite the source and its date.
2. Post the answer with the `factory-loop:done` marker, then close as completed. If the ticket also says to create a file, do that as in the build flow and commit it first.

## 4. Build flow

Building the wrong thing wastes everyone's time, so build tickets go through four stages. Each stage that needs a human ends the run for that ticket; the next run picks it up after the human replies.

### Stage 1: Clarifying questions

Read the ticket and, for a feature, the project's `CLAUDE.md` and code. List every assumption you would otherwise have to make, and ask about the ones that change what gets built. Good questions name the options and say what you'd pick by default, so the human can reply "defaults are fine".

```markdown
Before I build this, a few questions:

1. **<topic>:** <question>? Options: A, B. I'd default to A because <reason>.
2. ...

Reply here; "defaults are fine" works too. I'll post a plan for approval next.

<!-- factory-loop:questions -->
```

Add the `awaiting-answers` label, creating it if it doesn't exist: `gh label create awaiting-answers -R <repo> --color FBCA04 2>/dev/null; gh issue edit <n> -R <repo> --add-label awaiting-answers`. Leave the ticket open.

### Stage 2: Plan

Once the human has answered, remove `awaiting-answers`, then post the plan:

```markdown
**Plan for approval**

**Decisions from your answers:** <each answer and what it means>

**What I'll build:**
- <user-visible behaviour 1>
- ...

**Files:** <new and changed files, with one line each>

**Tests:** <what each test covers>

**Browser check:** <the steps I'll click through and screenshot>

**Not included:** <anything deliberately left out>

Reply "approved" to start, or tell me what to change.

<!-- factory-loop:plan -->
```

Add the `awaiting-approval` label the same way. Leave the ticket open.

### Stage 3: Build

Once approved, remove `awaiting-approval`, then:

1. `git pull --ff-only`, then build exactly what the plan says. Changes that come up mid-build go in the final comment.
2. **New project:** a new top-level folder with its own `CLAUDE.md`, tests, and a row in the root `CLAUDE.md` index. **Existing project:** read its `CLAUDE.md` first and follow its conventions.
3. Write tests for every behaviour in the plan, run them, and fix failures. Then briefly break the main behaviour, confirm a test fails, and restore it.
4. Commit specific paths, not `git add -A`, and push. End the message with `(refs #<n>)`, not `(closes #<n>)`: a closing keyword would close the ticket before the browser check has passed.

### Stage 4: Verify in the browser and attach screenshots

Tests prove the logic. The browser check proves a person can actually use it.

1. **Serve the project** from a local server so the page has a normal origin, started in the background: `python -m http.server 8765 --directory <project>`. Stop it when done.
2. **Open it with chrome-devtools.** Prefer the repo's `chrome-isolated` server, from `.mcp.json`, which uses a throwaway profile. Fall back to the plugin's `chrome-devtools` server. Use `new_page` with `isolatedContext` set to the ticket number, for a clean storage state.
3. **Click through every item in the plan's browser check.** Use `take_snapshot` to find elements, then `fill`, `click` and `press_key`. Assert results with `evaluate_script` or a snapshot, not by assuming. Check `list_console_messages` for errors. Also try one bad input and a reload.
4. **Screenshot each key state** with `take_screenshot` and `filePath`, saved to `<project>/docs/screenshots/issue-<n>/01-<what>.png`, `02-...`, and so on. Read each image back to check it shows what its name says.
5. **Commit and push the screenshots,** then embed them in the final comment by commit SHA so the links never change:
   `![Adding a task](https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<project>/docs/screenshots/issue-<n>/01-add.png)`

**If the browser can't start,** don't kill other Chrome processes. Post the work done with the `factory-loop:blocked` marker, add the `needs-browser-check` label, say exactly what failed, and leave the ticket **open**. A ticket isn't finished until the browser check passes.

### Final comment and close

```markdown
**Answer:** <one sentence: what now exists>

<what was built, where, and how to use it>

**Testing:** <tests run and results, including the break-it check>

**Browser check:** <each step clicked through and its result; console errors, if any>

<screenshots, each with a one-line caption>

**Commits:** <sha> on main

<!-- factory-loop:done -->
```

Then close: `gh issue close <n> -R <repo> --reason completed`.

## 5. Report

End with a short table:

| Ticket | Stage reached | Action taken | Link |
|---|---|---|---|

List tickets waiting on a human and what they are waiting for, and any failures with their error text.

The repo's Stop hook, `.claude/hooks/on-stop.sh`, also commits and pushes leftover changes at every stop as a safety net. Still commit ticket work explicitly, so commits have clear messages and link the issue.
