#!/usr/bin/env python3
"""Score the Coach panel against gold sentences.

    python training/coach_benchmark/eval_panel.py                  # signals only
    python training/coach_benchmark/eval_panel.py --llm            # + free-tier LLM edits (needs GROQ_API_KEY etc.)
    python training/coach_benchmark/eval_panel.py --url http://host:8080 --only es

Key metric: "missed_wrong" counts sentences with real errors that the panel called
excellent. That is the failure users notice most.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOLD = Path(__file__).parent / "gold.jsonl"
LLM_SCRIPT = ROOT / "firebase/functions/scripts/panel-llm.js"


def post(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{url}/panel", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def llm_edits(text: str, language: str) -> list[dict]:
    out = subprocess.run(
        ["node", str(LLM_SCRIPT), language, text], capture_output=True, text=True, timeout=120
    )
    if out.returncode != 0:
        print(f"  llm error: {out.stderr.strip()[:200]}", file=sys.stderr)
        return []
    return json.loads(out.stdout).get("edits", [])


def overlaps(text: str, original: str, issue: dict) -> bool:
    idx = text.find(original)
    if idx < 0:
        idx = text.lower().find(original.lower())
    return idx >= 0 and issue["start"] < idx + len(original) and idx < issue["end"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--llm", action="store_true")
    ap.add_argument("--only", choices=["es", "fr", "en"])
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    rows = [json.loads(l) for l in GOLD.read_text().splitlines() if l.strip()]
    if args.only:
        rows = [r for r in rows if r["language"] == args.only]

    m = dict(sentences=0, wrong=0, missed_wrong=0, correct=0, false_alarm=0,
             gold_spans=0, found_spans=0, issues=0, true_issues=0, exact=0)
    for r in rows:
        text, lang = r["text"], r["language"]
        payload = {"text": text, "language": lang}
        if args.llm:
            payload["llm_edits"] = llm_edits(text, lang)
        res = post(args.url, payload)
        errors = [i for i in res["issues"] if i["status"] == "error"]

        m["sentences"] += 1
        if r["errors"]:
            m["wrong"] += 1
            m["missed_wrong"] += res["verdict"] == "excellent"
        else:
            m["correct"] += 1
            m["false_alarm"] += bool(errors)
        m["gold_spans"] += len(r["errors"])
        m["found_spans"] += sum(any(overlaps(text, g, i) for i in res["issues"]) for g in r["errors"])
        m["issues"] += len(errors)
        m["true_issues"] += sum(any(overlaps(text, g, i) for g in r["errors"]) for i in errors)
        m["exact"] += res["corrected"].strip() == r["corrected"].strip()

        if args.verbose or (r["errors"] and res["verdict"] == "excellent") or (not r["errors"] and errors):
            print(f"{r['id']}: {res['verdict']}  {res['signals']}")
            for i in res["issues"]:
                print(f"   [{i['status']} {i['score']}] {i['original']!r} -> {i['replacement']!r}  {','.join(i['sources'])}")

    pct = lambda a, b: f"{100 * a / b:.0f}%" if b else "n/a"
    print("\n=== Coach panel benchmark ===")
    print(f"sentences            {m['sentences']}  (wrong {m['wrong']}, correct {m['correct']})")
    print(f"wrong called excellent  {m['missed_wrong']}/{m['wrong']}  ({pct(m['missed_wrong'], m['wrong'])})  lower is better")
    print(f"false alarms on correct {m['false_alarm']}/{m['correct']}  ({pct(m['false_alarm'], m['correct'])})  lower is better")
    print(f"error recall            {pct(m['found_spans'], m['gold_spans'])}")
    print(f"error precision         {pct(m['true_issues'], m['issues'])}")
    print(f"exact correction        {pct(m['exact'], m['sentences'])}")


if __name__ == "__main__":
    main()
