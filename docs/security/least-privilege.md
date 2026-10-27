# Least privilege: Proxmox and Home Assistant

**Current state:** the factory has **no** Proxmox or Home Assistant integration, and holds no credentials for either. On 27 Oct 2026 nothing in the repo, the Claude Code config or the environment referenced them. So least privilege today means *deny by default*:

- The guard blocks any command or `WebFetch` that targets a Proxmox API (`:8006`, `/api2/json`, `PVEAPIToken`, `pvesh`, `qm`, `pct`, `pveum`) or a Home Assistant API or webhook (`:8123`, `/api/webhook/`, `/api/services/`, `ha core`).
- The sandbox denies network access to `*.local`, `*.lan`, `*.home.arpa` and `*.nabu.casa`.
- `.agentignore` covers Proxmox token files and Home Assistant `secrets.yaml` and auth storage.
- `.claude/security/network-allowlist.txt` is empty.

If a future ticket genuinely needs either system, a **human** grants the narrowest access below. The agent never creates or holds these credentials itself.

## Proxmox VE

1. **A dedicated user, not root.** Root and `@pam` users can log in to the host.

   ```bash
   pveum user add factory@pve --comment "Software factory agent, read-only"
   ```

2. **A custom role with only what the ticket needs.** For monitoring, that's audit privileges alone. Never `Administrator`, `PVEAdmin` or `PVEVMAdmin`.

   ```bash
   pveum role add FactoryAudit --privs "VM.Audit,Datastore.Audit,Sys.Audit"
   ```

   Add `VM.PowerMgmt` only if a ticket needs start and stop, and only on the specific VMs.

3. **Grant on the narrowest path.** Use one VM or one pool, not `/`.

   ```bash
   pveum acl modify /vms/100 --users factory@pve --roles FactoryAudit
   ```

4. **A privilege-separated API token with an expiry.** With `--privsep 1` the token gets *no* rights until you grant them to the token itself. It can never exceed the user.

   ```bash
   pveum user token add factory@pve agent --privsep 1 --expire $(date -d '+30 days' +%s) --comment "factory, expires in 30 days"
   pveum acl modify /vms/100 --tokens 'factory@pve!agent' --roles FactoryAudit
   ```

5. **Store the secret outside the repo.** Put it in the OS credential store or a git-ignored env file listed in `.agentignore`, and pass it to tools by environment-variable *name*. Then add the single host to `.claude/security/network-allowlist.txt`.

6. **Review and expire.**
   - `pveum user token list factory@pve` shows the token.
   - `pveum user token remove factory@pve agent` revokes it.
   - Let it expire, then re-issue it only if it's still needed.

Check these flags against the `pveum` help on your Proxmox version.

## Home Assistant

**Webhooks** are unauthenticated by design: the webhook ID *is* the secret.
- Use long random IDs, set `local_only: true`, and allow only `POST`.
- Make each automation validate its payload and do one narrow thing.
- Never give the agent a webhook that unlocks doors, disarms alarms or controls heating limits.

**Long-lived access tokens** carry their user's full rights, and Home Assistant can't scope them.
- Don't give the agent one.
- If one is unavoidable, create a dedicated **non-admin** user for it, give it access only where it must have it, and revoke the token when the ticket is done.

**Allowlisting.** Add the single host to `.claude/security/network-allowlist.txt` only after the steps above. Prefer exposing one narrow webhook over any API token.

## Allowlist rules

- One host or `host:port` per line. Only a human edits the file; the guard stops the agent from changing it.
- Every entry should say who added it, why, and when it expires. Remove it once the ticket is done.
- Allowlisting a host only lifts the API rule. Secret paths, force pushes and every other rule still apply.
