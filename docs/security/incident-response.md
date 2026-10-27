# Incident response: suspected compromise of the factory agent

Use this if you see any of these signs:
- the agent acted on a ticket's hidden instructions
- the audit log shows blocked attempts you didn't expect
- `--verify-log` reports tampering
- commits or pushes appeared that nobody approved
- a secret may have been printed, committed or sent

Work top to bottom. Containment comes before investigation.

## 1. Contain

1. **Stop the loop.** Close the Claude Code session, or cancel the `/loop` job, so nothing else runs unattended.
2. **Stop auto-push.** Rename `.claude/hooks/on-stop.sh` by hand. The agent can't. Also remove the user-level Stop hook from `~/.claude/settings.json`.
3. **Protect `main`.** In the repo's GitHub settings, require pull requests and block force pushes on `main`, if that isn't already on.
4. **Pause tickets.** Add a `security-hold` label to open issues, so a restarted loop doesn't pick them up before you've finished.

## 2. Assess

```bash
python .claude/hooks/guard.py --verify-log                  # is the audit trail intact?
grep '"decision": "deny"' ~/.claude/logs/factory-guard-audit.jsonl | tail -50
grep '"event": "stop-hook"' ~/.claude/logs/factory-guard-audit.jsonl | tail -50   # what auto-push did
git log --since="3 days ago" --stat origin/main             # what reached main
gh api repos/<owner>/<repo>/events --paginate | head -200    # pushes, PR merges, deleted branches
```

Look for:
- **Denied calls** with rules `secret-path`, `credential-access`, `download-exec` or `guard-tamper`. These are the attempts the guard stopped.
- **Allowed calls** that touched the network or wrote files you didn't expect.
- **Commits** that changed `.claude/`, `.agentignore`, `.mcp.json`, CI workflows or `package.json` scripts.
- **The trigger:** the tickets and comments the loop read just before the event. Note which text did it.

## 3. Rotate credentials

Rotate everything the agent's machine could reach, even if the log shows nothing was read. Start with the GitHub login, because it can push code.

| Credential | Revoke | Re-issue |
|---|---|---|
| GitHub CLI login, used to push | GitHub → Settings → Applications → Authorized OAuth Apps → GitHub CLI → **Revoke**. Then run `gh auth logout`. | `gh auth login --web` |
| GitHub personal access tokens | GitHub → Settings → Developer settings → Tokens → **Delete** any token on this machine | Create a new fine-grained token limited to the one repo, with an expiry |
| Git Credential Manager | `git credential-manager erase` for `github.com`, or Windows Credential Manager → remove `git:https://github.com` | Signs in again on the next push |
| SSH keys | GitHub → Settings → SSH keys → delete. Remove the key from `~/.ssh`. | `ssh-keygen -t ed25519` and add the new public key |
| Anthropic / Claude login | Claude Console → API keys → **Revoke**, or sign out with `/logout` | `/login` |
| DeepSec credentials, if you added any | Revoke the key at its provider. Delete `.deepsec/.env.local`. | Local mode needs no key |
| Proxmox tokens, if ever created | `pveum user token remove factory@pve agent` | Per [least-privilege.md](least-privilege.md), with a new expiry |
| Home Assistant tokens and webhooks | Profile → Security → delete long-lived tokens. Change every webhook ID. | Per [least-privilege.md](least-privilege.md) |

If a secret reached the **public repo**, revoking it is what matters. Removing it from history is secondary, because clones and caches already have it. After rotation, ask GitHub Support to purge cached views if needed.

## 4. Clean up and recover

1. **Undo bad commits** with `git revert` on a branch, merged through a reviewed PR. Don't force-push over history.
2. **Restore guard files from a known-good commit**, by hand: `.claude/settings.json`, `.claude/hooks/`, `.agentignore` and `.mcp.json`. Then run the guard tests:

   ```bash
   python -m unittest discover -s .claude/hooks/tests -v
   ```

3. **Close the gap.** If the attempt got further than it should have, add a test for it in `.claude/hooks/tests/test_guard.py` and a rule in `guard.py`. If it worked by persuading the model, add the case to the "Untrusted input" section of the factory-loop skill.
4. **Restart in order.** Restore the Stop hook, remove `security-hold`, and restart the loop.

## 5. Record

Write a short note in a private issue or document: what happened, when, which ticket or text triggered it, what the guard blocked, and what was rotated. Keep the audit log file, and a copy of its `--verify-log` output, with the note.
