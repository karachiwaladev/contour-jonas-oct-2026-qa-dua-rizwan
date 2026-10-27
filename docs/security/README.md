# Factory security

The factory agent reads GitHub issues written by other people and acts on them unattended. That makes **prompt injection** the main threat: text in a ticket, comment, web page or file that tries to make the agent do something nobody asked for. The defences below assume the model *can* be fooled, and stop the dangerous action anyway.

## Layers

| Layer | Where | What it does | Bypassable by the agent? |
|---|---|---|---|
| Instructions | `.claude/skills/factory-loop/SKILL.md`, "Untrusted input" | Treats tickets, comments, HTML comments, links and quoted text as data. Only trusts members. | Yes, if fooled; that's why the next layers exist |
| Guard hook | `.claude/hooks/guard.py`, run as a `PreToolUse` hook on **every** tool call | Parses each command or file access and blocks the dangerous ones. Fails closed. | No: it runs outside the model, and edits to it are blocked |
| Deny rules | `permissions.deny` in `.claude/settings.json` | Claude Code's built-in rules: a quick first filter | Partly: prefix matching misses `rm -r -f` and `"rm" -rf`, which the guard catches |
| File access list | `.agentignore` and the guard's built-in defaults | Paths that may never be read, searched, copied, sent or written | No: enforced by the guard |
| Sandbox | `sandbox` in `.claude/settings.json` | Runs shell commands with network limited to GitHub, npm and PyPI, and secret folders unreadable | See [Sandbox caveats](#sandbox-caveats) |
| Audit log | `~/.claude/logs/factory-guard-audit.jsonl` | Every guard decision and every auto-push, hash-chained so edits and deletions show | No: written by the hook, outside the repo |

## What the guard blocks

| Rule | Examples |
|---|---|
| `rm-rf` | `rm -rf`, `rm -r -f`, `"rm" -rf`, `\rm -rf`, `find -delete`, `xargs rm -rf`, `Remove-Item -Recurse -Force`, `rd /s /q`, `git clean -f` |
| `force-push` / `remote-delete` | `git push --force`, `-f`, `--force-with-lease`, `+refspec`, `--mirror`, `--delete`, `:branch`, force updates through `gh api` |
| `history-rewrite` | `git reset --hard`, `git filter-branch`, `git filter-repo`, `git branch -D` |
| `download-exec` | `curl … \| sh`, `wget … \| bash`, `bash <(curl …)`, `sh -c "$(curl …)"`, `iex (iwr …)`, base64-decode piped to a shell, download then run |
| `secret-path` | `.env*` (except `.env.example`), private keys, `~/.ssh`, `~/.aws`, the GitHub CLI and Claude credential files, anything in `.agentignore`, through any tool or shell command |
| `credential-access` | `gh auth token`, `git credential fill`, `printenv`, `$GITHUB_TOKEN`-style variables, PowerShell `env:` dumps, the OS credential store |
| `secret-value` | Writing a token or private key into any file |
| `guard-tamper` | Editing settings, hooks, `.agentignore`, `.mcp.json`, `.git/hooks` or `.git/config`. Also `--no-verify`, `core.hooksPath`, `--dangerously-skip-permissions`, and setting `FACTORY_GUARD_*` |
| `repo-admin` | `gh repo delete/edit`, `gh secret`, `gh ssh-key`, collaborator, webhook, key or branch-protection changes, DELETE through `gh api` |
| `sensitive-api` | Proxmox (`:8006`, `/api2/json`, `pvesh`, `qm`, `pct`, `pveum`) and Home Assistant (`:8123`, `/api/webhook/`, `/api/services/`, `ha core`), unless allowlisted |

Ordinary work still runs: normal pushes, `gh issue`/`pr` commands, tests, npm and npx, reading the guard's own files, and deleting single files.

**Changing the guard.** The agent can't edit its own guard. A human edits the files directly, or starts Claude Code with `FACTORY_GUARD_UNLOCK_CONFIG=1` for one deliberate change. That variable lifts only the config-edit rule, never the others.

## Testing

```bash
python -m unittest discover -s .claude/hooks/tests -v
```

The 40 tests pipe real hook payloads into the guard. They cover:
- every rule above, plus bypass spellings: quoting, escaping, wrappers like `sudo`, `env`, `xargs` and `timeout`, command substitution, PowerShell and cmd.exe forms
- legitimate factory commands that must keep working
- fail-closed behaviour on bad input
- log redaction, plus hash-chain verification that catches both edited and deleted entries

## Audit log

```bash
python .claude/hooks/guard.py --verify-log      # "OK: N entries, chain intact" or "TAMPERED: line N …"
```

Each entry records:
- the time, session, tool and decision
- the rule and the reason
- the command or path, with tokens, passwords and `Authorization` headers redacted

Each entry's hash covers the previous one, so removing or editing a line breaks the chain from that point. The log lives in your home folder, not the repo, so it's never pushed publicly. Keep it as long as you'd want to investigate an incident.

## Sandbox caveats

The repo's settings turn the sandbox on with `failIfUnavailable: false`. If the sandbox can't start, for example on Windows before `/sandbox` is set up, commands run unsandboxed with a warning, and the guard still applies.

`gh` and `git push`/`pull`/`fetch` run outside the sandbox (`excludedCommands`). They need your GitHub login, and the guard still checks them.

To confirm the sandbox is active in a session, run `/sandbox`.

## Related

- [least-privilege.md](least-privilege.md): Proxmox and Home Assistant access
- [incident-response.md](incident-response.md): what to do and what to rotate if you suspect a compromise
