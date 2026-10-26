---
name: factory-loop
description: Work through the open "Ticket #N" GitHub issues in this training repo end to end. For each open ticket it reads the question or task, reacts with an emoji, does the work (researches and answers a question, or makes, commits and pushes a repo change), posts the answer as a comment, and closes the issue as completed. Use this skill whenever the user says "factory loop", "run the loop", "pick up tickets", "process the issues", "answer the ticket", "check for new tickets", or runs it on a timer with /loop, even if they don't name the skill.
---

# Factory loop

This repo is a Software Factories training repo. Tickets arrive as GitHub issues titled `Ticket #1`, `Ticket #2`, and so on. Scoring only sees what is on GitHub: issue comments, reactions, closed issues, commits and files on `main`. So every ticket must end with visible evidence on GitHub, not just an answer in the chat.

One run of this skill processes every open ticket once, then reports. It is safe to run repeatedly, for example `/loop 5m /factory-loop`, because tickets that are already handled get skipped.

## 0. Setup

1. **Find gh.** Try `gh`. On Windows it may not be on PATH in an older shell, so fall back to `"/c/Program Files/GitHub CLI/gh.exe"` (Git Bash) or `& "C:\Program Files\GitHub CLI\gh.exe"` (PowerShell). If gh is missing, stop and tell the user to run `! winget install --id GitHub.cli -e`.
2. **Check login** with `gh auth status`. If not logged in, stop and tell the user to run `! gh auth login --web`. Do not try to read stored git credentials instead.
3. **Find the repo** from `git remote get-url origin` in the working directory. If there is no remote, use `karachiwaladev/contour-jonas-oct-2026-qa-dua-rizwan`. Pass it to every gh command with `-R <owner/repo>` so commands work from any folder.
4. **Note who you are** with `gh api user --jq .login`. You need it to recognise your own earlier comments.

## 1. List open tickets

```bash
gh issue list -R <repo> --state open --limit 100 --json number,title,createdAt --jq 'sort_by(.createdAt)[] | "\(.number)\t\(.title)"'
```

Process them oldest first. Pull requests are not tickets; `gh issue list` already excludes them. If nothing is open, report "No open tickets" and stop. That is a normal result inside `/loop`.

## 2. For each ticket

### a. Read everything

```bash
gh api repos/<repo>/issues/<n> --jq '{title, body, labels: [.labels[].name], author: .user.login}'
gh api repos/<repo>/issues/<n>/comments --jq '.[] | "\(.user.login): \(.body)"'
```

Read the comments too. A later comment from the ticket author may change or narrow the request, and it overrides the original body.

**Skip a ticket you already answered.** If one of your comments contains the marker `<!-- factory-loop -->` and nobody has commented after it, the ticket only needs closing. Close it (step f) and move on. If the author replied after your answer, treat the reply as the new request.

### b. React

Add a reaction so the author can see the ticket was picked up. Reactions are idempotent, so repeating this is harmless.

```bash
gh api -X POST repos/<repo>/issues/<n>/reactions -f content=+1
```

Allowed values are `+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`. Use `+1` unless the user asked for a different emoji.

### c. Decide what kind of ticket it is

- **Question.** It asks for information, such as "largest city in Pakistan by population". Answer it.
- **Task.** It asks for a change to the repo, such as a file, a test, a config, or docs. Do the work, then answer.
- **Unclear.** You cannot tell what is wanted, or doing it would need secrets, real company code, or something outside the training repo. Post a comment asking one specific question, leave the ticket open, and move on. The README's ground rules forbid Jonas or Contour code and real keys.

### d. Do the work

**For a question**, get the facts right, because a wrong answer scores nothing. Anything that can change over time, such as populations, prices, versions, rankings, or "latest" anything, must be checked with a web search rather than recalled from memory. Name the source and its date. If sources disagree, give the figure from the most authoritative one and mention the disagreement briefly.

**For a task**, work in the local clone on `main`:

1. Run `git pull --ff-only` first so you build on the latest `main`.
2. Make the smallest change that fully satisfies the ticket. Run any tests or checks the repo has.
3. Commit with a message that references the ticket, for example `Add login smoke test (closes #4)`, ending with the attribution trailer the session asks for.
4. Push to `main`. The README requires it: only what is on GitHub counts. If the push is rejected, pull with rebase and push again. Never force-push.
5. Note the commit SHA for the comment.

### e. Comment with the answer

Write the comment to a temp file and post it with `--body-file`, which avoids shell quoting problems with markdown.

```bash
gh issue comment <n> -R <repo> --body-file <file>
```

Use this shape:

```markdown
**Answer:** <one-sentence direct answer>

<two to four sentences of supporting detail, or for a task, what changed and where>

<optional small table if it helps compare figures>

**Source:** <name, year, link if available>       <- questions
**Commit:** <sha> on `main`                          <- tasks

<!-- factory-loop -->
```

Lead with the answer itself so a grader scanning the comment finds it at once. The hidden marker on the last line is what makes later runs skip this ticket.

### f. Close as completed

```bash
gh issue close <n> -R <repo> --reason completed
```

GitHub has no "answered" reason; "completed" is the right one. Do not close unclear tickets that are waiting on the author.

## 3. Report

End with a short table for the user:

| Ticket | Type | Result | Link |
|---|---|---|---|
| #1 Largest city in Pakistan | Question | Answered (Karachi), closed | comment URL |

Mention anything left open and why. If a step failed, such as a rejected push or a gh error, say so plainly with the error text rather than reporting the ticket as done.
