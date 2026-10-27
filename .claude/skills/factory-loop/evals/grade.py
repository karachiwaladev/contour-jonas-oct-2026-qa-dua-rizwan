"""Grade factory-loop output with Jev, TypeSafe AI's decision model.

Jev answers typed questions about a text with probabilities; it never writes text.
This script turns a checklist into yes/no questions, sends the text once, and
reports a probability per item plus the mean, so a skill edit can be measured
before and after instead of judged by eye.

Usage, from the repo root:

  python .claude/skills/factory-loop/evals/grade.py --self-test
  python .claude/skills/factory-loop/evals/grade.py --text comment.md --eval 1
  python .claude/skills/factory-loop/evals/grade.py --text pr-body.md --questions q.json
  python .claude/skills/factory-loop/evals/grade.py --text out.md --eval 2 --json result.json

--eval N takes the checklist of eval N in evals/evals.json. --questions takes a
JSON file: either a list of strings or {"name": "question text", ...}.

The key is read from JEV_API_KEY or TYPESAFE_API_KEY in the environment, else
from .env at the repo root. It is never printed or written anywhere.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API = "https://api.typesafe.ai/v1"
MODEL = "jev-latest"
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
KEY_NAMES = ("JEV_API_KEY", "TYPESAFE_API_KEY")


def load_key() -> str:
    for name in KEY_NAMES:
        if os.environ.get(name):
            return os.environ[name].strip()
    env_path = os.path.join(REPO, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*(?:export\s+)?(JEV_API_KEY|TYPESAFE_API_KEY)\s*=\s*(.*)$", line)
                if m:
                    return m.group(2).strip().strip('"').strip("'")
    sys.exit("No key: set JEV_API_KEY in the environment or in .env at the repo root.")


def call(path: str, key: str, body: dict | None = None, retries: int = 4) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path,
        data=data,
        method="POST" if data else "GET",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            if e.code in (429, 529) and attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            if e.code == 401:
                sys.exit("Jev rejected the key (401). Check JEV_API_KEY.")
            sys.exit(f"Jev returned HTTP {e.code}: {detail}")
    sys.exit("Jev stayed rate-limited or overloaded after retries.")


def questions_from_eval(eval_id: int) -> dict[str, str]:
    with open(os.path.join(HERE, "evals.json"), encoding="utf-8") as f:
        evals = json.load(f)["evals"]
    for ev in evals:
        if ev["id"] == eval_id:
            return {f"item{i + 1}": q for i, q in enumerate(ev["checklist"])}
    sys.exit(f"No eval with id {eval_id} in evals.json.")


def questions_from_file(path: str) -> dict[str, str]:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    if isinstance(raw, list):
        return {f"item{i + 1}": q for i, q in enumerate(raw)}
    return {str(k): str(v) for k, v in raw.items()}


def grade(text: str, questions: dict[str, str], key: str) -> dict:
    body = {
        "model": MODEL,
        "state": text,
        "questions": {
            name: {
                "type": "noul",
                "instructions": "Judging only the text given: " + q
                + " Answer yes only if the text shows it, not if it merely claims it.",
            }
            for name, q in questions.items()
        },
    }
    resp = call("/systemone", key, body)
    answers = resp.get("answers", {})
    rows = []
    for name, q in questions.items():
        p = answers.get(name, {}).get("noul")
        rows.append({"name": name, "question": q, "p_yes": p})
    scored = [r["p_yes"] for r in rows if isinstance(r["p_yes"], (int, float))]
    return {
        "model": resp.get("model"),
        "usage": resp.get("usage"),
        "mean_p_yes": round(sum(scored) / len(scored), 3) if scored else None,
        "items": rows,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--self-test", action="store_true", help="check the key against /v1/models and exit")
    ap.add_argument("--text", help="file whose contents are graded")
    ap.add_argument("--eval", type=int, help="use the checklist of this eval id from evals.json")
    ap.add_argument("--questions", help="JSON file of questions (list, or name->question map)")
    ap.add_argument("--json", dest="json_out", help="also write the full result to this file")
    args = ap.parse_args()

    key = load_key()
    if args.self_test:
        models = call("/models", key).get("models", [])
        print("Key accepted. Models:", ", ".join(m.get("name", "?") for m in models) or "(none listed)")
        return
    if not args.text or not (args.eval or args.questions):
        ap.error("--text plus --eval N or --questions FILE is required (or --self-test)")

    with open(args.text, encoding="utf-8") as f:
        text = f.read()
    questions = questions_from_eval(args.eval) if args.eval else questions_from_file(args.questions)
    result = grade(text, questions, key)

    width = max(len(r["question"]) for r in result["items"])
    for r in result["items"]:
        p = "  n/a" if r["p_yes"] is None else f"{r['p_yes']:5.2f}"
        print(f"{p}  {r['question']:<{width}}")
    print(f"\nmean p(yes) = {result['mean_p_yes']}  model = {result['model']}  tokens = {result['usage']}")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        print("written:", args.json_out)


if __name__ == "__main__":
    main()
