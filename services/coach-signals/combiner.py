"""Merge candidate edits from independent signals into one verdict.

Overlapping candidates form a group. Independent agreement raises confidence:
1 - prod(1 - c_i), one vote per source. Source weights live in combiner_weights.json
so they can be refit from the benchmark without code changes.
"""

from __future__ import annotations

import json
from pathlib import Path

from signals.edits import Candidate

WEIGHTS = json.loads((Path(__file__).parent / "combiner_weights.json").read_text())


def _overlaps(a: Candidate, b: Candidate) -> bool:
    return a.start < b.end and b.start < a.end


def _group(cands: list[Candidate]) -> list[list[Candidate]]:
    groups: list[list[Candidate]] = []
    for c in sorted(cands, key=lambda c: (c.start, c.end)):
        for g in groups:
            if any(_overlaps(c, o) for o in g):
                g.append(c)
                break
        else:
            groups.append([c])
    return groups


def _score(group: list[Candidate]) -> float:
    best_per_source: dict[str, float] = {}
    for c in group:
        w = c.confidence * WEIGHTS["source_scale"].get(c.source, 1.0)
        best_per_source[c.source] = max(best_per_source.get(c.source, 0.0), min(w, 0.99))
    miss = 1.0
    for v in best_per_source.values():
        miss *= 1.0 - v
    return 1.0 - miss


def _pick(group: list[Candidate]) -> Candidate:
    votes: dict[str, float] = {}
    for c in group:
        if c.replacement is not None:
            votes[c.replacement] = votes.get(c.replacement, 0.0) + c.confidence
    llm = [c for c in group if c.source.startswith("llm")]
    base = max(llm or group, key=lambda c: c.confidence)
    if votes:
        replacement = max(votes, key=votes.get)
        holder = next((c for c in group if c.replacement == replacement), base)
        if holder.source.startswith("llm") or not llm:
            base = holder
        return Candidate(**{**base.__dict__, "replacement": replacement})
    return base


def combine(text: str, cands: list[Candidate]) -> dict:
    error_t, possible_t = WEIGHTS["error_threshold"], WEIGHTS["possible_threshold"]
    issues = []
    for g in _group(cands):
        score = _score(g)
        if score < possible_t:
            continue
        chosen = _pick(g)
        issues.append(
            {
                **chosen.to_dict(),
                "score": round(score, 3),
                "status": "error" if score >= error_t else "possible",
                "sources": sorted({c.source for c in g}),
            }
        )
    errors = [i for i in issues if i["status"] == "error"]
    verdict = "needs_work" if errors else ("check" if issues else "excellent")
    return {"verdict": verdict, "issues": issues, "corrected": apply_edits(text, errors)}


def apply_edits(text: str, issues: list[dict]) -> str:
    out = text
    for i in sorted(issues, key=lambda i: i["start"], reverse=True):
        if i.get("replacement") is not None:
            out = out[: i["start"]] + i["replacement"] + out[i["end"] :]
    return out
