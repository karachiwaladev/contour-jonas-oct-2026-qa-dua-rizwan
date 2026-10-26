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

The loop posts as the same GitHub account as the human, so tell comments apart by **marker**, not by author. A comment containing `<!-- factory-loop` is the loop's; any other comment is a **human reply**.

**Reopened tickets come first.** Check when the ticket was last reopened:

```bash
gh api repos/<repo>/issues/<n>/events --jq '[.[] | select(.event == "reopened")] | last | .created_at'
```

If it was reopened **after** the loop's latest `factory-loop:done` comment, or after an older plain `<!-- factory-loop -->` comment, it is a **reopened ticket**. Never just close it again: use the reopened flow in section 5.

Otherwise, find the loop's latest marker:

| Latest loop marker | Human replied after it? | Stage |
|---|---|---|
| none | | **New:** react 👍, classify, start the right flow |
| `factory-loop:plan` | no | Waiting for answers and approval: skip |
| `factory-loop:plan` | yes, answering and approving | **Build** |
| `factory-loop:plan` | yes, with changes or new answers | Post a revised **questions and plan** |
| `factory-loop:questions` | no | Waiting for an answer: skip |
| `factory-loop:questions` | yes | Post **questions and plan** |
| `factory-loop:done`, or the older `factory-loop` | no | Close if still open, then skip |
| `factory-loop:done` | yes | Treat the reply as a follow-up request |
| `factory-loop:blocked` | no | Waiting on a human: skip |
| `factory-loop:blocked` | yes | Retry the blocked step, such as the browser check |

Approval is any human reply that clearly agrees, such as "approved", "yes", "defaults are fine", "go ahead", "lgtm" or "ship it". If a reply answers the questions but it's unclear whether it approves the plan, post a revised plan asking only for approval rather than guessing.

**Classify a new ticket:**
- **Question:** it only asks for information. Use the question flow.
- **Build:** it asks for a new project or app, or a feature or change in an existing project. Use the build flow.
- **Small factory change:** a doc, config or file outside any project, such as editing `CLAUDE.md`. Do it directly as in the build stage, without questions or browser checks.
- **Unclear:** ask one specific question with the `factory-loop:questions` marker.

## 3. Question flow

1. Research the answer. Anything that can change, such as populations, prices, versions or rankings, must come from a web search. Cite the source and its date.
2. Post the answer with the `factory-loop:done` marker, then close as completed. If the ticket also says to create a file, do that as in the build flow and commit it first.

## 4. Build flow

Building the wrong thing wastes everyone's time, so build tickets go through three stages. The questions and plan go out together in one comment, so the human needs to reply only once before the build starts.

### Stage 1: Questions and plan, in one comment

Read the ticket and, for a feature, the project's `CLAUDE.md` and code. List every assumption you would otherwise have to make, and ask about the ones that change what gets built. Each question names the options and the default you'd pick. Then write the plan **as if the defaults are accepted**, so a single reply of "approved" or "defaults are fine" answers everything and starts the build.

```markdown
**Questions and plan for approval**

**Questions** (I've assumed the default in bold for the plan below):
1. **<topic>:** <question>? Options: **A (default)**, B. <why A>
2. ...

**What I'll build:**
- <user-visible behaviour 1>
- ...

**Files:** <new and changed files, one line each>

**Tests:** <what each test covers>

**Browser check:** <the steps I'll click through and screenshot>

**Not included:** <anything deliberately left out>

Reply **"approved"** to build with the defaults, or answer any question and I'll post a revised plan.

<!-- factory-loop:plan -->
```

If the ticket is so clear that there's nothing worth asking, say "No open questions" and keep the plan. Add the `awaiting-approval` label, creating it if missing: `gh label create awaiting-approval -R <repo> --color FBCA04 2>/dev/null; gh issue edit <n> -R <repo> --add-label awaiting-approval`. Leave the ticket open.

If the reply changes any answer, post a revised questions-and-plan comment and wait again. If it approves, with or without small notes that don't change the plan, go to the build.

### Stage 2: Build

Once approved, remove `awaiting-approval`, then:

1. `git pull --ff-only`, then build exactly what the plan says. Changes that come up mid-build go in the final comment.
2. **New project:** a new top-level folder with its own `CLAUDE.md`, tests, and a row in the root `CLAUDE.md` index. **Existing project:** read its `CLAUDE.md` first and follow its conventions.
3. Write tests for every behaviour in the plan, run them, and fix failures. Then briefly break the main behaviour, confirm a test fails, and restore it.
4. Commit specific paths, not `git add -A`, and push. End the message with `(refs #<n>)`, not `(closes #<n>)`: a closing keyword would close the ticket before the browser check has passed.

### Stage 3: Verify in the browser and attach screenshots

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

Then remove any `awaiting-approval` or `needs-browser-check` label and close: `gh issue close <n> -R <repo> --reason completed`.

## 5. Reopened tickets

A human reopened a ticket the loop had finished. They want something more, not the same work again.

1. **Read why.** Look for a human comment posted around or after the reopen. If there is one, treat it as the request: a question goes to the question flow, and a change goes to the build flow, starting with questions and plan.
2. **No reason given:** for a build ticket, keep the existing code and run **verify and screenshot**:
   - Pull, run the project's tests, and confirm they pass.
   - Run the browser check in build stage 3 against every behaviour the ticket originally asked for, plus one bad input and a reload.
   - If the check finds a bug, fix it with a test, then rerun the check. Larger changes worth making go in a questions-and-plan comment instead of being built.
   - Commit the screenshots and post the final comment with the `factory-loop:done` marker. Then close as completed.
   For a question ticket with no reason given, recheck the facts with a fresh search and post an updated answer.
3. **If the browser can't start,** follow the build stage 3 rule: post with `factory-loop:blocked`, add `needs-browser-check`, and leave it open.


## 6. Report

End with a short table:

| Ticket | Stage reached | Action taken | Link |
|---|---|---|---|

List tickets waiting on a human and what they are waiting for, and any failures with their error text.

The repo's Stop hook, `.claude/hooks/on-stop.sh`, also commits and pushes leftover changes at every stop as a safety net. Still commit ticket work explicitly, so commits have clear messages and link the issue.
