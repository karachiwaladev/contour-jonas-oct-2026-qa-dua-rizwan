---
name: security-review
description: Free, fast security review of a change or project in this repo - dependency audit, secret scan, dangerous-sink search for XSS and code injection, shell-script checks, DeepSec's free pattern scan, and a reasoned review of the threat model - with each candidate triaged as a real issue or false positive and real issues fixed with a test. Use it before committing any build-ticket work in the factory loop, and whenever the user asks for a security check, security review, vulnerability scan, audit, "is this safe", or "check for secrets", even if they don't name the skill. For DeepSec's paid AI review, use the deepsec skill.
---

# Security review

Every build ticket gets this review before its work is committed. It costs nothing: all tools are local, and no AI service is billed. It catches the issues that matter most in this repo:
- user input rendered as HTML
- secrets pushed to a public repo
- shell injection in hooks
- vulnerable dependencies

**Scanners find candidates, not vulnerabilities.** A pattern hit is a lead. Every candidate gets one of three verdicts, with a one-line reason:
- **Real:** fix it with a test.
- **False positive:** say why.
- **Needs a human:** say what is unclear.

## Scope

Review what the ticket changed, plus anything it touches:

```bash
git diff --name-only origin/main...HEAD    # committed on this branch
git diff --name-only; git diff --name-only --cached; git ls-files --others --exclude-standard  # not yet committed
```

For a full audit, when the user asks, review the whole repo, excluding `node_modules/` and `.deepsec/`.

## 1. Automated checks

Run each check that applies, from the repo root. Record the command and result for the report.

**Dependencies.** For every changed project with a `package.json`:

```bash
(cd <project> && npm audit --omit=dev; npm audit)
```

Production dependencies matter most. A dev-only advisory, such as one in a test tool, is low severity unless it runs on untrusted input.

**Secrets.** Search the changed files for credentials, and never print a matched value in full:

```bash
git grep -nIE '(-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|xox[bpas]-[A-Za-z0-9-]{10,}|(api[_-]?key|secret|password|token)\s*[:=]\s*["'\''][^"'\'' ]{8,})' -- <changed files>
```

Also check that `.env*`, `*.pem` and `*.key` files are untracked: `git ls-files | grep -E '\.env|\.pem$|\.key$'`. Detection patterns inside `on-stop.sh` and this skill are expected and are not leaks.

**Dangerous sinks in browser code.** These turn user input into code or HTML:

```bash
git grep -nE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|setTimeout\(\s*["'\'']|setInterval\(\s*["'\'']|\.(href|src)\s*=|javascript:' -- '*.js' '*.html' ':!**/node_modules/**' ':!**/tests/**'
```

For each hit, trace where the value comes from. A constant string is fine. Anything from user input, storage or the URL is a candidate.

**Shell scripts and hooks.** For each changed `.sh`, run `bash -n <file>` for syntax. Then read it for:
- unquoted `$VAR` expansions, especially paths and JSON from stdin
- `eval`
- `rm`, `git push --force`, `reset --hard` or `clean`
- anything reaching outside the repo

`shellcheck` isn't installed, so do this by reading.

**DeepSec pattern scan.** It's free and takes under a second:

```bash
cd .deepsec && pnpm deepsec scan
```

Then read the candidates in `.deepsec/data/*/files/**/*.json`. Each has `vulnSlug`, `lineNumbers` and `snippet`. Triage them yourself, or offer the deepsec skill's AI review for a deeper look.

## 2. Reasoned review

Tools miss logic flaws. Read the changed code against the threat model in `.deepsec/data/*/INFO.md` and ask:

- **Input to output:** where does user input go? Is it escaped for that context: HTML, attribute, URL, shell or SQL?
- **Storage:** does stored data get trusted on read? Older records may lack fields, and stored data can be tampered with in DevTools.
- **Authority:** does anything act with more power than it needs, such as pushing, deleting, or calling the network?
- **Secrets and privacy:** could the change commit, log or display something private? `.claude/logs/prompts.jsonl` is public.
- **Supply chain:** were dependencies added? Are they pinned, maintained and needed? Is anything loaded from a CDN without a fixed version?

## 3. Fix and prove

For each **real** finding:
1. Write a test that demonstrates it, such as the XSS payload test in `todo/tests/ui.test.js`, and watch it fail.
2. Fix it and watch the test pass.
3. Run the full test suite.

If a fix is large or needs a design decision, leave the ticket open with the finding marked **Needs a human**. Never ship a known-exploitable issue silently.

## 4. Report

Add this section to the ticket's final comment and to any chat summary:

```markdown
**Security review:**

| Check | Result |
|---|---|
| Dependencies (`npm audit`) | 0 production vulnerabilities; 1 low in dev tooling |
| Secrets | None found |
| Dangerous sinks | 2 `innerHTML` hits, both constant strings: false positives |
| Shell scripts | `bash -n` passes; no unquoted input |
| DeepSec scan | 2 candidates, both false positives (reasons) |

**Findings:** none real. *Or:* a table of severity, file, issue and fix, with the test that proves it.
```

**The repo is public.** For a real vulnerability that isn't fixed yet, describe it in general terms in public comments and commits, without a working exploit. Then fix it in the same ticket.
