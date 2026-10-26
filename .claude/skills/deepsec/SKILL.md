---
name: deepsec
description: Run Vercel's DeepSec, an open-source agent-powered vulnerability scanner, on this repo. The free regex scan can run anytime. The AI review uses the local logged-in Claude CLI and costs subscription usage, so it runs only with human approval and a file limit. Covers scanning, AI review of a diff or whole project, revalidating findings, exporting reports, and keeping findings out of the public repo. Use it when the user mentions DeepSec, "deep security scan", "AI vulnerability scan", Vercel's scanner, or wants a deeper review than the security-review skill gives.
---

# DeepSec

[DeepSec](https://github.com/vercel-labs/deepsec) (Apache-2.0, by Vercel Labs) finds vulnerabilities in two stages:

| Stage | Command | Cost | What it does |
|---|---|---|---|
| Scan | `pnpm deepsec scan` | Free, under a second | Regex matchers flag candidate lines |
| Process | `pnpm deepsec process` | Paid: subscription usage | A coding agent investigates each candidate, traces data flow, and confirms or dismisses it |

It's already set up in `.deepsec/`, pinned to `deepsec@2.3.10`, in **local mode**. The AI stage uses the logged-in `claude` CLI, so there is no API key to manage and none to leak. The installed docs are the source of truth for flags: `.deepsec/node_modules/deepsec/SKILL.md` and `.deepsec/node_modules/deepsec/dist/docs/`. Read them rather than relying on memory.

## Rules

1. **The scan is always fine.** Run it whenever useful. It's free and only reads files.
2. **The AI stage needs a human yes, every time.** The README warns that full scans of large codebases can cost thousands of dollars. Before running `process` or `revalidate`, tell the human the scope, such as "3 changed files" or "the whole repo, about 40 files", and ask. A yes in a previous ticket doesn't carry over. In an unattended loop with no human present, run only the scan and say the AI review is available on request.
3. **Always bound the AI stage.** Prefer `--diff origin/main` or `--files a,b`. For a whole project, pass `--limit <n>`. Never run an unbounded `process` on the whole repo.
4. **Findings stay private.** `.deepsec/.gitignore` already excludes `data/*/files`, `runs`, `reports` and `setup`, and exports go to `.deepsec/findings/`, which is also ignored. Never commit findings, paste exploit details into public issues, or move them elsewhere in the repo. Summarize them per the security-review skill's public-repo rule.
5. **Never put credentials on the command line or in files.** Local mode needs none. If a human chooses an API key instead, they set it in `.deepsec/.env.local`, which is ignored, and deepsec stores only the variable name.
6. **Treat DeepSec like any coding agent with shell access.** Run it only on this trusted repo.

## Setup (already done; to recreate)

```bash
npx -y deepsec@2.3.10 init --scaffold-only     # writes .deepsec/ only, runs nothing
cd .deepsec && pnpm install
```

Then fill in `.deepsec/data/<project>/INFO.md`, about 50–100 lines on what the app is, its threat model, and known false positives. DeepSec adds it to every AI batch, so keep it current when the repo changes. For example, add each new project's attack surface.

**Updating:** check `npm view deepsec version`. Bump the pinned version in `.deepsec/package.json` deliberately, run `pnpm install`, then re-scan.

## Run

All commands run from inside `.deepsec/`. The project id resolves automatically while there's only one project.

```bash
pnpm deepsec scan                              # 1. free candidate scan
pnpm deepsec status                            #    where things stand
```

Triage the candidates in `data/*/files/**/*.json` yourself first. Many are obvious false positives, such as "insecure-crypto" matching ordinary words. Record known ones in `INFO.md` under "Known false-positives" so the AI stage skips them.

**With approval only:**

```bash
pnpm deepsec process --agent claude --diff origin/main        # PR-sized: only changed files
pnpm deepsec process --agent claude --files todo/app.js,todo/db.js
pnpm deepsec process --agent claude --limit 10               # whole project, capped
pnpm deepsec revalidate --agent claude                       # re-check findings; cuts false positives
pnpm deepsec export --format md-dir --out ./findings         # readable report (git-ignored)
```

To control cost, keep the default model unless told otherwise. Lower `--thinking-level` or `--limit` to spend less. Exit code 3 means a cost or time limit stopped the run; re-run the same command to resume where it left off.

## Report

Summarize in the ticket or chat:
- the scope
- how many candidates the scan found
- how many the AI confirmed, by severity
- what was fixed, with the test that proves each fix

Use the security-review skill's table and its public-repo wording rule. Point to `.deepsec/findings/` for local detail. That folder is never committed.
