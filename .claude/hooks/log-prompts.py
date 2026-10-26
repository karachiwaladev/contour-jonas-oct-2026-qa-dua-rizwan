"""Stop hook: append this session's new user prompts to a JSONL log.

Reads the hook payload on stdin, walks the session transcript, and appends
every real user prompt not already in the log. One JSON object per line.
Dedupes on the transcript message uuid, so running on every stop is safe.
"""
import json
import os
import sys

SKIP_PREFIXES = ("<local-command-stdout>", "<local-command-stderr>", "<task-notification>")


def prompt_text(content):
    """Return the prompt text, or None if this entry is not a typed prompt."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        # Tool results are also stored as "user" entries; they are not prompts.
        if any(b.get("type") == "tool_result" for b in content if isinstance(b, dict)):
            return None
        text = "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    else:
        return None
    text = text.strip()
    if not text or text.startswith(SKIP_PREFIXES):
        return None
    return text


def main():
    payload = json.load(sys.stdin)
    transcript = payload.get("transcript_path")
    if not transcript or not os.path.exists(transcript):
        return

    # PROMPT_LOG_FILE overrides the default <project>/.claude/logs/prompts.jsonl.
    log_path = os.environ.get("PROMPT_LOG_FILE")
    if not log_path:
        project = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or "."
        log_path = os.path.join(project, ".claude", "logs", "prompts.jsonl")
    log_path = os.path.expanduser(log_path)
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    seen = set()
    if os.path.exists(log_path):
        with open(log_path, encoding="utf-8") as f:
            for line in f:
                try:
                    seen.add(json.loads(line).get("uuid"))
                except ValueError:
                    pass

    new = []
    with open(transcript, encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
                continue
            if entry.get("isCompactSummary") or entry.get("uuid") in seen:
                continue
            text = prompt_text(entry.get("message", {}).get("content"))
            if text is None:
                continue
            new.append({
                "timestamp": entry.get("timestamp"),
                "session_id": entry.get("sessionId") or payload.get("session_id"),
                "uuid": entry.get("uuid"),
                "cwd": entry.get("cwd"),
                "prompt": text,
            })

    if new:
        with open(log_path, "a", encoding="utf-8") as f:
            for record in new:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
