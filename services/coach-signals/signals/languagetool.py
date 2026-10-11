"""LanguageTool signal. Self-host in production; the public API is for development (20 req/min)."""

from __future__ import annotations

import os

import httpx

from .edits import Candidate

LT_URL = os.environ.get("LT_URL", "https://api.languagetool.org").rstrip("/")
LT_LANG = {"es": "es", "fr": "fr", "en": "en-US"}

CATEGORY_CONFIDENCE = {
    "TYPOS": 0.8,
    "GRAMMAR": 0.75,
    "CONFUSED_WORDS": 0.7,
    "CASING": 0.5,
    "PUNCTUATION": 0.35,
    "TYPOGRAPHY": 0.2,
    "STYLE": 0.25,
    "REDUNDANCY": 0.25,
}
KIND = {"TYPOS": "spelling", "PUNCTUATION": "punctuation", "TYPOGRAPHY": "punctuation", "STYLE": "style"}


async def check(client: httpx.AsyncClient, text: str, language: str) -> list[Candidate]:
    resp = await client.post(
        f"{LT_URL}/v2/check",
        data={"text": text, "language": LT_LANG[language], "level": "picky"},
        timeout=20,
    )
    resp.raise_for_status()
    out: list[Candidate] = []
    for m in resp.json().get("matches", []):
        start, length = m["offset"], m["length"]
        category = m.get("rule", {}).get("category", {}).get("id", "")
        reps = [r["value"] for r in m.get("replacements", [])[:3]]
        out.append(
            Candidate(
                start=start,
                end=start + length,
                original=text[start : start + length],
                replacement=reps[0] if reps else None,
                source="languagetool",
                confidence=CATEGORY_CONFIDENCE.get(category, 0.5),
                kind=KIND.get(category, "grammar"),
                message=m.get("message", ""),
                extra={"rule": m.get("rule", {}).get("id"), "category": category, "alternatives": reps[1:]},
            )
        )
    return out
