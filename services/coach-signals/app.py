"""Parlance Coach signal server: independent grammar signals plus the combiner.

POST /panel  {text, language, llm_edits?: [{original, replacement, explanation, type, verified}]}
  -> {verdict, issues, corrected, signals}

Firebase `coachPanel` calls this with edits from the free-tier LLM pool. LLM keys never
live here; this server only runs free, local signals.
"""

from __future__ import annotations

import asyncio
import os

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from combiner import combine
from signals import agreement, languagetool
from signals.edits import Candidate, locate

LLM_CONFIDENCE = {True: 0.8, False: 0.5}
TOKEN = os.environ.get("SIGNALS_TOKEN", "")
MAX_CHARS = 4000

app = FastAPI(title="parlance-coach-signals")
client = httpx.AsyncClient()


class LlmEdit(BaseModel):
    original: str
    replacement: str
    explanation: str = ""
    type: str = "grammar"
    verified: bool = False


class PanelRequest(BaseModel):
    text: str = Field(max_length=MAX_CHARS)
    language: str = Field(pattern="^(es|fr|en)$")
    llm_edits: list[LlmEdit] = []


@app.get("/health")
def health() -> dict:
    return {"ok": True}


def llm_candidates(text: str, edits: list[LlmEdit]) -> list[Candidate]:
    used: set[int] = set()
    out = []
    for e in edits:
        if e.original == e.replacement:
            continue
        idx = locate(text, e.original, used)
        if idx < 0:
            continue
        used.add(idx)
        out.append(
            Candidate(
                start=idx,
                end=idx + len(e.original),
                original=text[idx : idx + len(e.original)],
                replacement=e.replacement,
                source="llm_verified" if e.verified else "llm",
                confidence=LLM_CONFIDENCE[e.verified],
                kind=e.type,
                message=e.explanation,
            )
        )
    return out


@app.post("/panel")
async def panel(req: PanelRequest, authorization: str = Header(default="")) -> dict:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "bad token")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is required")

    signals: dict[str, str] = {}

    async def run_lt() -> list[Candidate]:
        try:
            res = await languagetool.check(client, text, req.language)
            signals["languagetool"] = "ok"
            return res
        except Exception as exc:
            signals["languagetool"] = f"error: {type(exc).__name__}"
            return []

    async def run_agreement() -> list[Candidate]:
        try:
            res = await asyncio.to_thread(agreement.check, text, req.language)
            signals["agreement"] = "ok"
            return res
        except Exception as exc:
            signals["agreement"] = f"error: {type(exc).__name__}"
            return []

    lt, ag = await asyncio.gather(run_lt(), run_agreement())
    llm = llm_candidates(text, req.llm_edits)
    signals["llm"] = f"{len(llm)} edits" if req.llm_edits else "none"
    return {**combine(text, lt + ag + llm), "signals": signals}
