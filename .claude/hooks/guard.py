#!/usr/bin/env python3
"""Factory guard: a PreToolUse hook that blocks dangerous or unauthorized tool calls.

Claude Code runs this before every tool call and passes the call as JSON on stdin.
Exit 0 allows the call. Exit 2 blocks it, and stderr tells Claude why.

Why a hook and not only permission rules: permission rules match command prefixes,
so `rm -r -f`, `"rm" -rf`, `\\rm -rf` or `find -exec rm -rf` slip past `Bash(rm -rf *)`.
This guard parses the command and checks what it would actually do.

What it blocks (see docs/security/README.md for the full policy):
  * recursive force deletes (rm -rf and equivalents, PowerShell and cmd.exe forms)
  * force pushes, remote branch deletes, history rewrites, git clean, reset --hard
  * downloading code and running it (curl | sh, bash <(curl ...), iex (iwr ...))
  * reading, copying or sending secrets: paths in .agentignore plus built-in defaults
  * dumping credentials or environment variables that hold secrets
  * changing the guard's own configuration (settings, hooks, .agentignore, .git/hooks)
  * Proxmox and Home Assistant APIs and CLIs, unless the host is allowlisted
  * repo administration through gh: deleting repos, secrets, keys, collaborators
  * writing secret values into files

It fails closed: any internal error blocks the call. Every decision is appended to a
hash-chained audit log outside the repo (verify with `guard.py --verify-log`).

Usage:
  guard.py                       hook mode: read one tool call from stdin
  guard.py --only-from DIR       hook mode, but act only when the session's project dir is DIR
  guard.py --verify-log [PATH]   check the audit log's hash chain
  guard.py --log-event TYPE MSG  append a non-tool event (used by on-stop.sh)
"""
import hashlib
import json
import os
import posixpath
import re
import shlex
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))  # .claude/hooks/guard.py -> repo
IS_WINDOWS = os.name == "nt"

# ---------------------------------------------------------------------------
# Built-in protected paths. .agentignore adds to these; "!pattern" re-allows.
# Same syntax as .gitignore: no slash = any file with that name, a slash = relative
# to the repo root, "~/" = the home folder, "**" = any depth.
# ---------------------------------------------------------------------------
DEFAULT_SECRET_PATTERNS = [
    ".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template",
    "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "*.kdbx",
    "id_rsa", "id_rsa.*", "id_dsa", "id_ecdsa", "id_ed25519", "id_ed25519.*",
    ".git-credentials", ".netrc", "_netrc", ".npmrc", ".pypirc", ".pgpass",
    "credentials.json", ".credentials.json", "secrets.json", "secrets.yaml", "secrets.yml",
    "~/.ssh/", "~/.aws/", "~/.azure/", "~/.kube/", "~/.docker/config.json", "~/.gnupg/",
    "~/.config/gh/", "~/AppData/Roaming/GitHub CLI/", "~/.claude/.credentials.json",
    "~/.config/git/credentials",
    ".deepsec/.env*",
    "!*.pub",  # public keys are not secret; last so it wins over "~/.ssh/" (last match wins)
]
# Absolute system paths, which gitignore-style patterns can't express (a leading "/" means
# the repo root there).
SYSTEM_SECRET_RE = re.compile(r"(^|/)proc/[^/]+/(environ|cmdline|mem)$|(^|/)etc/(shadow|gshadow|sudoers)$", re.I)

# Files that configure or are the guard. The agent may read them but never change them,
# otherwise a prompt injection could simply switch the guard off. A human can edit them
# directly, or start Claude Code with FACTORY_GUARD_UNLOCK_CONFIG=1 for a deliberate change.
CONTROL_PATTERNS = [
    "/.claude/settings.json", "/.claude/settings.local.json", "/.claude/hooks/",
    "/.claude/security/", "/.agentignore", "/.mcp.json", "/.git/hooks/", "/.git/config",
    "~/.claude/settings.json", "~/.claude/settings.local.json", "~/.claude/hooks/",
]

SECRET_VALUE_RE = re.compile(
    r"(-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|gh[pousr]_[A-Za-z0-9]{36}"
    r"|github_pat_[A-Za-z0-9_]{40,}"
    r"|sk-ant-[A-Za-z0-9_-]{20,}"
    r"|sk-[A-Za-z0-9]{32,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|xox[bpas]-[A-Za-z0-9-]{10,}"
    r"|PVEAPIToken=[^\s'\"]+"
    r"|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})"  # JWT, e.g. HA tokens
)
REDACT_RE = re.compile(SECRET_VALUE_RE.pattern + r"|(?i:(bearer|authorization:?)\s+\S+)"
                       r"|(?i:(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*\S+)")

NET_TOOLS = r"(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|aria2c|http|https|fetch)"
SHELLS = (r"(?:sh|bash|zsh|dash|ksh|fish|ash|python[0-9.]*|py|node|deno|bun|perl|ruby|php"
          r"|pwsh|powershell|iex|invoke-expression|cmd|source)")
DOWNLOAD_EXEC_RES = [
    re.compile(r"\b" + NET_TOOLS + r"\b[^;&\n]*\|\s*(?:sudo\s+)?(?:[\w./-]*/)?" + SHELLS + r"\b", re.I),
    re.compile(r"<\(\s*" + NET_TOOLS + r"\b", re.I),
    re.compile(r"\b(?:eval|iex|invoke-expression|(?:ba|z|da|k)?sh\s+-c|python[0-9.]*\s+-c|node\s+-e)"
               r"\s*\(?\s*[\"']?\s*\$?\(\s*" + NET_TOOLS + r"\b", re.I),
    re.compile(r"\b(?:iex|invoke-expression)\b[^;\n]*\b" + NET_TOOLS + r"\b", re.I),
    re.compile(r"\b(?:base64\s+(?:-d|--decode|-D)|certutil\s+-decode|xxd\s+-r)\b[^;&\n]*\|\s*" + SHELLS + r"\b", re.I),
]

# Proxmox VE and Home Assistant: deny by default (docs/security/least-privilege.md).
SENSITIVE_API_RES = [
    re.compile(r":8006\b"), re.compile(r"/api2/(?:json|extjs)\b", re.I), re.compile(r"PVEAPIToken", re.I),
    re.compile(r"/api/webhook/", re.I), re.compile(r"/api/services/", re.I),
    re.compile(r":8123\b"), re.compile(r"homeassistant|home-assistant|nabu\.casa", re.I),
]
SENSITIVE_CLIS = {"pvesh", "qm", "pct", "pveum", "pvenode", "pvecm", "pveam", "hass-cli"}

SECRET_ENV_RE = re.compile(
    r"\$(?:\{|env:)?[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Za-z_0-9]*",
    re.I)

TAMPER_RE = re.compile(r"FACTORY_GUARD|disableAllHooks|dangerously-skip-permissions|bypassPermissions"
                       r"|allowManagedHooksOnly|--no-verify\b", re.I)

FILE_TOOLS_WRITE = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
FILE_TOOLS_READ = {"Read"}

MESSAGE_TAIL = (" This is a security policy of the software factory, not an error to work around: "
                "do not retry it another way. If a human really needs this, say so and let them do it.")


class Blocked(Exception):
    def __init__(self, rule, reason):
        super().__init__(reason)
        self.rule = rule
        self.reason = reason


# ---------------------------------------------------------------------------
# Paths and patterns
# ---------------------------------------------------------------------------
def _home():
    return os.path.expanduser("~").replace("\\", "/").rstrip("/")


def norm_path(p, cwd=""):
    """Absolute, forward-slash, lower-case (on Windows) path, with ~ and $VARS expanded."""
    p = (p or "").strip().strip("\"'").lstrip("@")
    if not p:
        return ""
    if p.startswith("~"):
        p = _home() + p[1:]
    p = os.path.expandvars(p).replace("\\", "/")
    m = re.match(r"^/([a-zA-Z])(/.*)?$", p)  # Git Bash /c/Users -> c:/Users
    if m:
        p = m.group(1) + ":" + (m.group(2) or "/")
    if not re.match(r"^([a-zA-Z]:)?/", p):
        base = (cwd or os.getcwd()).replace("\\", "/")
        mb = re.match(r"^/([a-zA-Z])(/.*)?$", base)
        if mb:
            base = mb.group(1) + ":" + (mb.group(2) or "/")
        p = base.rstrip("/") + "/" + p
    drive = ""
    if re.match(r"^[a-zA-Z]:", p):
        drive, p = p[:2], p[2:]
    p = drive + posixpath.normpath(p)
    return p.lower() if IS_WINDOWS else p


def glob_to_regex(pat):
    out, i = [], 0
    while i < len(pat):
        c = pat[i]
        if pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return "".join(out)


def compile_patterns(lines, root):
    """gitignore-style lines -> [(negated, regex)]. Last match wins."""
    root = norm_path(root, root).rstrip("/")
    compiled = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        neg = line.startswith("!")
        if neg:
            line = line[1:].strip()
        line = line.replace("\\", "/").rstrip("/")
        if not line:
            continue
        if line.startswith("~/"):
            base = norm_path(line)
            anchored = True
        elif line.startswith("/"):
            base = root + line
            anchored = True
        elif re.match(r"^[a-zA-Z]:/", line):
            base = norm_path(line)
            anchored = True
        elif "/" in line:
            base = root + "/" + line
            anchored = True
        else:
            base, anchored = line, False
        if IS_WINDOWS:
            base = base.lower()
        body = glob_to_regex(base)
        rx = ("^" + body if anchored else r"^(?:.*/)?" + body) + r"(?:/.*)?$"
        compiled.append((neg, re.compile(rx, re.I if IS_WINDOWS else 0)))
    return compiled


def matches(compiled, path):
    hit = False
    for neg, rx in compiled:
        if rx.match(path):
            hit = not neg
    return hit


def load_agentignore(root):
    path = os.path.join(root, ".agentignore")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().splitlines()
    except OSError:
        return []


def load_allowlist(root):
    path = os.path.join(root, ".claude", "security", "network-allowlist.txt")
    try:
        with open(path, encoding="utf-8") as f:
            return [l.strip().lower() for l in f if l.strip() and not l.strip().startswith("#")]
    except OSError:
        return []


class Policy:
    def __init__(self, root=REPO_ROOT):
        self.root = root
        self.secrets = compile_patterns(DEFAULT_SECRET_PATTERNS + load_agentignore(root), root)
        self.control = compile_patterns(CONTROL_PATTERNS, root)
        self.allowlist = load_allowlist(root)
        self.unlocked = os.environ.get("FACTORY_GUARD_UNLOCK_CONFIG") == "1"

    def is_secret(self, path):
        return bool(path) and (matches(self.secrets, path) or bool(SYSTEM_SECRET_RE.search(path)))

    def is_control(self, path):
        return bool(path) and matches(self.control, path)

    def host_allowed(self, text):
        low = text.lower()
        return any(entry and entry in low for entry in self.allowlist)


# ---------------------------------------------------------------------------
# Shell command analysis
# ---------------------------------------------------------------------------
def views(cmd):
    """(command view, path view). The command view drops quotes and backslash escapes,
    so `"rm" -rf`, `r\\m -rf` and `\\rm -rf` all read as `rm -rf`."""
    joined = re.sub(r"\\\r?\n", " ", cmd)
    cmd_view = re.sub(r"[\"'\\]", "", joined)
    cmd_view = re.sub(r"[ \t]+", " ", cmd_view)
    path_view = re.sub(r"[\"']", "", joined).replace("\\", "/")
    return cmd_view, path_view


SEG_SPLIT = re.compile(r"\|\||&&|\$\(|[;&|\n`(){}]")


def segments(cmd_view):
    return [s.strip() for s in SEG_SPLIT.split(cmd_view) if s.strip()]


def shlex_segments(cmd):
    """Quote-aware parse: `git -c "a=b c" push --force` keeps "a=b c" as one token.
    Returns a list of token lists, or [] if the command can't be parsed (the
    quote-stripped parse still runs, so an unparseable command isn't a bypass)."""
    s = re.sub(r"\\\r?\n", " ", cmd)
    s = s.replace("`", " ; ").replace("$(", " ; ( ").replace("\r", " ").replace("\n", " ; ")
    try:
        lex = shlex.shlex(s, posix=True, punctuation_chars=";&|()<>")
        lex.whitespace_split = True
        lex.commenters = ""
        toks = list(lex)
    except ValueError:
        return []
    segs, cur = [], []
    for t in toks:
        if t and set(t) <= set(";&|()<>"):
            if cur:
                segs.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        segs.append(cur)
    return segs


def base(tok):
    t = tok.lower().replace("\\", "/").rsplit("/", 1)[-1]
    return t[:-4] if t.endswith(".exe") else t


def flags_of(tokens):
    out = []
    for t in tokens:
        if t == "--":
            break
        if t.startswith("-") or (t.startswith("/") and len(t) <= 3):
            out.append(t.lower())
    return out


def check_delete(seg_tokens):
    names = [base(t) for t in seg_tokens]
    for i, name in enumerate(names):
        rest = seg_tokens[i + 1:]
        fl = flags_of(rest)
        if name == "rm":
            short = "".join(f[1:] for f in fl if f.startswith("-") and not f.startswith("--"))
            longs = [f for f in fl if f.startswith("--")]
            rec = "r" in short or "--recursive" in longs or any(f.startswith("-rec") for f in fl)
            frc = "f" in short or "--force" in longs or any(f.startswith("-fo") for f in fl)
            if rec and frc:
                raise Blocked("rm-rf", "Recursive force delete (rm -rf or equivalent) is not allowed.")
        if name in ("remove-item", "ri", "del", "erase", "rd", "rmdir", "rm"):
            rec = any(f == "-r" or f.startswith("-rec") or f == "/s" for f in fl)
            frc = any(f.startswith("-fo") or f == "/q" for f in fl)
            if rec and (frc or f"/s" in fl and name in ("rd", "rmdir", "del", "erase")):
                raise Blocked("rm-rf", "Recursive force delete (Remove-Item -Recurse -Force, rd /s) is not allowed.")
        if name == "find" and any(t.lower() == "-delete" for t in rest):
            raise Blocked("rm-rf", "find -delete removes files recursively and is not allowed.")


GIT_OPTS_WITH_VALUE = {"-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"}


def git_subcommand(tokens):
    """Return (subcommand, args) for a git invocation that starts at tokens[0]."""
    i = 1
    while i < len(tokens):
        t = tokens[i]
        if t in GIT_OPTS_WITH_VALUE:
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t.lower(), tokens[i + 1:]
    return "", []


def check_git(seg_tokens):
    for i, t in enumerate(seg_tokens):
        if base(t) != "git":
            continue
        sub, args = git_subcommand(seg_tokens[i:])
        fl = flags_of(args)
        short = "".join(f[1:] for f in fl if f.startswith("-") and not f.startswith("--"))
        if sub == "push":
            if ("f" in short or any(f.startswith("--force") for f in fl) or "--mirror" in fl
                    or any(a.startswith("+") or ":+" in a for a in args)):
                raise Blocked("force-push", "Force pushes (--force, -f, --force-with-lease, +refspec, --mirror) are not allowed.")
            if "d" in short or "--delete" in fl or "--prune" in fl or any(a.startswith(":") and len(a) > 1 for a in args):
                raise Blocked("remote-delete", "Deleting remote branches or tags with git push is not allowed.")
        elif sub == "reset" and "--hard" in fl:
            raise Blocked("history-rewrite", "git reset --hard discards work and is not allowed.")
        elif sub == "clean" and ("f" in short or "--force" in fl):
            raise Blocked("rm-rf", "git clean -f deletes untracked files and is not allowed.")
        elif sub in ("filter-branch", "filter-repo"):
            raise Blocked("history-rewrite", "Rewriting git history is not allowed.")
        elif sub == "branch" and ("D" in "".join(f[1:] for f in args if f.startswith("-") and not f.startswith("--"))
                                  or ("--delete" in fl and "--force" in fl)):
            raise Blocked("history-rewrite", "Force-deleting branches (git branch -D) is not allowed.")
        elif sub in ("credential", "credential-manager", "credential-manager-core"):
            raise Blocked("credential-access", "Reading stored git credentials is not allowed.")
        elif sub == "config" and any(re.search(r"credential|hookspath|core\.hookspath|alias\.", a, re.I) for a in args) \
                and not any(f in ("--get", "--list", "-l", "--get-all") for f in fl):
            raise Blocked("guard-tamper", "Changing git credential, hooks or alias config is not allowed.")


GH_BLOCKED = {
    ("repo", "delete"), ("repo", "edit"), ("repo", "archive"), ("repo", "rename"), ("repo", "deploy-key"),
    ("auth", "refresh"), ("auth", "logout"), ("ssh-key", None), ("gpg-key", None),
    ("secret", None), ("variable", None), ("release", "delete"), ("issue", "delete"), ("issue", "transfer"),
    ("label", "delete"), ("ruleset", None), ("cache", "delete"), ("codespace", None), ("org", None),
}


def check_gh(seg_tokens):
    for i, t in enumerate(seg_tokens):
        if base(t) != "gh":
            continue
        rest = [a for a in seg_tokens[i + 1:]]
        words = [a.lower() for a in rest if not a.startswith("-")]
        if not words:
            continue
        sub = words[0]
        sub2 = words[1] if len(words) > 1 else None
        if (sub, sub2) == ("auth", "token"):
            raise Blocked("credential-access", "Printing the GitHub token (gh auth token) is not allowed.")
        if (sub, sub2) in GH_BLOCKED or (sub, None) in GH_BLOCKED:
            raise Blocked("repo-admin", f"`gh {sub} {sub2 or ''}`".replace(" `", "`") +
                          " changes repository administration or exposes credentials, and is not allowed.")
        if sub == "auth" and sub2 == "status" and any(a in ("-t", "--show-token") for a in rest):
            raise Blocked("credential-access", "Printing the GitHub token is not allowed.")
        if sub == "api":
            low = " ".join(rest).lower()
            method = re.search(r"(?:-x|--method)\s*=?\s*(\w+)", low)
            m = method.group(1).upper() if method else "GET"
            if m == "DELETE":
                raise Blocked("repo-admin", "DELETE requests through gh api are not allowed.")
            if m != "GET" and re.search(r"/(collaborators|hooks|keys|actions/secrets|secrets|protection|rulesets|invitations)\b", low):
                raise Blocked("repo-admin", "Changing collaborators, webhooks, keys, secrets or branch protection is not allowed.")
            if re.search(r"/git/refs", low) and re.search(r"force\s*=\s*true", low):
                raise Blocked("force-push", "Force-updating refs through the API is not allowed.")


ENV_DUMP_CMDS = {"env", "printenv", "set", "export", "declare", "typeset", "compgen"}


def check_credentials(seg_tokens, raw_seg):
    names = [base(t) for t in seg_tokens]
    if not names:
        return
    first = names[0]
    if first in ("printenv",):
        raise Blocked("credential-access", "Dumping environment variables can leak secrets and is not allowed.")
    if first in ("env", "set", "export", "declare", "typeset") and (len(seg_tokens) == 1 or
                                                                    seg_tokens[1] in ("-p", "-x", "-0")):
        raise Blocked("credential-access", "Dumping environment variables can leak secrets and is not allowed.")
    low = raw_seg.lower()
    if re.search(r"\b(get-childitem|gci|dir|ls|get-item|gi)\s+env:", low) or "getenvironmentvariable" in low:
        raise Blocked("credential-access", "Reading PowerShell environment variables wholesale is not allowed.")
    if re.search(r"\b(cmdkey\s+/list|vaultcmd|get-storedcredential|secret-tool\s+lookup|keyring\s+get"
                 r"|security\s+find-(generic|internet)-password)\b", low):
        raise Blocked("credential-access", "Reading the OS credential store is not allowed.")


def check_paths(path_view, cwd, policy, write_intent_cmds):
    tokens = [t for t in re.split(r"[\s=<>|;&(),`]+", path_view) if t]
    for tok in tokens:
        if tok.startswith("-") or tok.startswith("$") and "/" not in tok:
            continue
        p = norm_path(tok, cwd)
        if policy.is_secret(p):
            raise Blocked("secret-path", f"Access to a protected secret path ({tok}) is not allowed.")
    if policy.unlocked:
        return
    # Writes to the guard's own configuration.
    for m in re.finditer(r">{1,2}\s*([^\s;&|]+)", path_view):
        if policy.is_control(norm_path(m.group(1), cwd)):
            raise Blocked("guard-tamper", "Changing the factory guard's configuration is not allowed.")
    for seg_tokens in write_intent_cmds:
        for tok in seg_tokens[1:]:
            # Split inline code too: python -c "open('.claude/settings.json','w')" hides
            # the path inside brackets and quotes.
            for part in re.split(r"[(),=;:\[\]{}\"'+]+", tok):
                if not part or part.startswith("-"):
                    continue
                if policy.is_control(norm_path(part, cwd)):
                    raise Blocked("guard-tamper", "Changing the factory guard's configuration is not allowed.")


WRITE_CMDS = {"tee", "cp", "mv", "rm", "del", "erase", "truncate", "install", "ln", "dd", "chmod", "chown",
              "attrib", "icacls", "set-content", "add-content", "out-file", "new-item", "ni", "remove-item", "ri",
              "copy-item", "copy", "cpi", "move-item", "move", "mi", "rename-item", "ren", "rni", "clear-content",
              "unlink", "patch", "rsync", "touch"}


def write_intent(seg_tokens):
    if not seg_tokens:
        return False
    name = base(seg_tokens[0])
    if name in WRITE_CMDS:
        return True
    if name in ("sed", "perl", "ruby") and any(t.startswith("-i") or t == "--in-place" for t in seg_tokens):
        return True
    if re.match(r"^(python[0-9.]*|py|node|pwsh|powershell)$", name) and any(t in ("-c", "-e", "-command", "-encodedcommand") for t in (x.lower() for x in seg_tokens)):
        return True
    if name == "git":
        sub, _ = git_subcommand(seg_tokens)
        return sub in ("checkout", "restore", "rm", "mv", "apply", "am", "stash", "update-index")
    return False


def check_shell(cmd, cwd, policy):
    if TAMPER_RE.search(cmd):
        raise Blocked("guard-tamper", "Commands that disable hooks, permissions or the factory guard are not allowed.")
    cmd_view, path_view = views(cmd)
    for rx in DOWNLOAD_EXEC_RES:
        if rx.search(cmd_view):
            raise Blocked("download-exec", "Downloading code and running it (curl | sh and similar) is not allowed.")
    if SECRET_ENV_RE.search(cmd):
        raise Blocked("credential-access", "Reading environment variables that hold secrets is not allowed.")
    # Two independent parses; a call is blocked if either one finds a problem.
    token_lists = [s.split() for s in segments(cmd_view)] + shlex_segments(cmd)
    downloaded = set()
    write_segs = []
    for toks in token_lists:
        if not toks:
            continue
        seg = " ".join(toks)
        check_delete(toks)
        check_git(toks)
        check_gh(toks)
        check_credentials(toks, seg)
        names = [base(t) for t in toks]
        if any(n in SENSITIVE_CLIS for n in names) or (names[0] == "ha" and len(names) > 1 and
                                                        names[1] in ("core", "supervisor", "host", "os", "addons", "backups")):
            raise Blocked("sensitive-api", "Proxmox and Home Assistant CLIs are not allowed for the agent.")
        # Download-then-run: curl -o x.sh URL ; bash x.sh
        if re.match(r"^" + NET_TOOLS + r"$", names[0], re.I):
            for j, t in enumerate(toks):
                if t in ("-o", "-O", "--output", "-OutFile", "-outfile") and j + 1 < len(toks):
                    downloaded.add(base(toks[j + 1]))
        elif downloaded and (names[0] in ("sh", "bash", "zsh", "pwsh", "powershell", "python", "python3", "node", "source", ".")
                             and any(base(t) in downloaded for t in toks[1:])
                             or base(toks[0]).lstrip("./") in downloaded):
            raise Blocked("download-exec", "Running a file that was just downloaded is not allowed.")
        if write_intent(toks):
            write_segs.append(toks)
    check_sensitive_text(cmd, policy)
    check_paths(path_view, cwd, policy, write_segs)


def check_sensitive_text(text, policy):
    for rx in SENSITIVE_API_RES:
        if rx.search(text) and not policy.host_allowed(text):
            raise Blocked("sensitive-api", "Proxmox and Home Assistant APIs and webhooks are denied by default. "
                          "Allowlist a host in .claude/security/network-allowlist.txt only with a scoped, "
                          "least-privilege token (docs/security/least-privilege.md).")


# ---------------------------------------------------------------------------
# Tool dispatch
# ---------------------------------------------------------------------------
def check(payload, policy):
    tool = payload.get("tool_name", "")
    ti = payload.get("tool_input") or {}
    cwd = payload.get("cwd") or os.getcwd()

    if tool in ("Bash", "PowerShell"):
        check_shell(ti.get("command", ""), cwd, policy)
        return

    path = ti.get("file_path") or ti.get("notebook_path") or ti.get("path") or ""
    if tool in FILE_TOOLS_READ | FILE_TOOLS_WRITE:
        p = norm_path(path, cwd)
        if policy.is_secret(p):
            raise Blocked("secret-path", f"{tool} of a protected secret path is not allowed.")
        if tool in FILE_TOOLS_WRITE:
            if policy.is_control(p) and not policy.unlocked:
                raise Blocked("guard-tamper", "Changing the factory guard's configuration is not allowed.")
            content = " ".join(str(ti.get(k, "")) for k in ("content", "new_string", "new_source"))
            content += " ".join(str(e.get("new_string", "")) for e in ti.get("edits", []) or [] if isinstance(e, dict))
            if SECRET_VALUE_RE.search(content):
                raise Blocked("secret-value", "Writing a secret value (token or private key) into a file is not allowed.")
        return

    if tool == "Grep":
        p = norm_path(path, cwd) if path else ""
        if p and policy.is_secret(p):
            raise Blocked("secret-path", "Searching a protected secret path is not allowed.")
        glob = ti.get("glob") or ""
        if glob and policy.is_secret(norm_path(glob, cwd)):
            raise Blocked("secret-path", "Searching protected secret files is not allowed.")
        return

    if tool == "WebFetch":
        check_sensitive_text(ti.get("url", ""), policy)
        return


# ---------------------------------------------------------------------------
# Audit log: append-only JSONL with a SHA-256 hash chain.
# ---------------------------------------------------------------------------
def audit_path():
    return os.environ.get("FACTORY_GUARD_AUDIT_LOG") or os.path.join(
        os.path.expanduser("~"), ".claude", "logs", "factory-guard-audit.jsonl")


def redact(text, limit=400):
    text = REDACT_RE.sub("[REDACTED]", str(text))
    return text if len(text) <= limit else text[:limit] + "…"


def _last_hash(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 8192))
            lines = f.read().decode("utf-8", "replace").strip().splitlines()
        return json.loads(lines[-1]).get("hash", "") if lines else ""
    except (OSError, ValueError, IndexError):
        return ""


def append_audit(entry):
    path = audit_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lock = path + ".lock"
    deadline = time.time() + 2
    fd = None
    while time.time() < deadline:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.time() - os.path.getmtime(lock) > 10:  # stale lock
                try:
                    os.remove(lock)
                except OSError:
                    pass
            time.sleep(0.02)
    try:
        entry["prev"] = _last_hash(path)
        body = json.dumps(entry, sort_keys=True, ensure_ascii=False)
        entry["hash"] = hashlib.sha256((entry["prev"] + body).encode("utf-8")).hexdigest()
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True, ensure_ascii=False) + "\n")
    finally:
        if fd is not None:
            os.close(fd)
            try:
                os.remove(lock)
            except OSError:
                pass


def verify_log(path):
    prev, n = "", 0
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            e = json.loads(line)
            h = e.pop("hash", "")
            if e.get("prev", "") != prev:
                return False, f"line {n}: chain broken (prev hash does not match line {n - 1})"
            body = json.dumps(e, sort_keys=True, ensure_ascii=False)
            if hashlib.sha256((prev + body).encode("utf-8")).hexdigest() != h:
                return False, f"line {n}: entry was modified (hash mismatch)"
            prev = h
    return True, f"{n} entries, chain intact"


def summarize(payload):
    ti = payload.get("tool_input") or {}
    for k in ("command", "file_path", "notebook_path", "url", "path", "pattern"):
        if ti.get(k):
            return redact(ti[k])
    return ""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
def _norm_dir(p):
    return norm_path(p, p).rstrip("/") if p else ""


def main(argv):
    if "--verify-log" in argv:
        i = argv.index("--verify-log")
        path = argv[i + 1] if len(argv) > i + 1 else audit_path()
        ok, msg = verify_log(path)
        print(("OK: " if ok else "TAMPERED: ") + msg)
        return 0 if ok else 1
    if "--log-event" in argv:
        i = argv.index("--log-event")
        append_audit({"ts": now(), "event": argv[i + 1], "detail": redact(" ".join(argv[i + 2:]))})
        return 0

    raw = sys.stdin.read()
    if "--only-from" in argv:
        want = _norm_dir(argv[argv.index("--only-from") + 1])
        try:
            proj = json.loads(raw).get("cwd", "")
        except ValueError:
            proj = ""
        proj = _norm_dir(os.environ.get("CLAUDE_PROJECT_DIR") or proj)
        if proj != want and not proj.startswith(want + "/"):
            return 0
        # The repo has its own project-level hook; don't run twice there.
        if proj == _norm_dir(REPO_ROOT) or proj.startswith(_norm_dir(REPO_ROOT) + "/"):
            if os.environ.get("CLAUDE_PROJECT_DIR") and _norm_dir(os.environ["CLAUDE_PROJECT_DIR"]) == _norm_dir(REPO_ROOT):
                return 0

    payload = json.loads(raw)
    policy = Policy()
    entry = {"ts": now(), "session": payload.get("session_id", ""), "tool": payload.get("tool_name", ""),
             "input": summarize(payload)}
    try:
        check(payload, policy)
    except Blocked as b:
        entry.update(decision="deny", rule=b.rule, reason=b.reason)
        try:
            append_audit(entry)
        finally:
            sys.stderr.write(f"Blocked by factory guard [{b.rule}]: {b.reason}{MESSAGE_TAIL}\n")
        return 2
    entry["decision"] = "allow"
    try:
        append_audit(entry)
    except OSError:
        pass  # logging must never turn an allowed call into a failure
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as e:  # fail closed
        sys.stderr.write(f"Blocked by factory guard [guard-error]: the guard failed ({type(e).__name__}: {e}), "
                         f"so the call was blocked to stay safe.{MESSAGE_TAIL}\n")
        sys.exit(2)
