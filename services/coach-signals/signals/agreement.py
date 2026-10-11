"""Agreement signal from a dependency parse: gender/number mismatches between linked words.

Generic structure checks, not per-sentence patterns. Parser morphology is imperfect,
so confidence is low and these mostly matter when another signal agrees.
"""

from __future__ import annotations

import spacy

from .edits import Candidate

MODELS = {"es": "es_core_news_sm", "fr": "fr_core_news_sm", "en": "en_core_web_sm"}
_nlp: dict[str, spacy.Language] = {}


def nlp(language: str) -> spacy.Language:
    if language not in _nlp:
        _nlp[language] = spacy.load(MODELS[language])
    return _nlp[language]


def _feat(tok, name: str) -> str | None:
    vals = tok.morph.get(name)
    return vals[0] if vals else None


def _mismatch(a, b, feats: tuple[str, ...]) -> str | None:
    for f in feats:
        va, vb = _feat(a, f), _feat(b, f)
        if va and vb and va != vb:
            return f
    return None


def check(text: str, language: str) -> list[Candidate]:
    doc = nlp(language)(text)
    out: list[Candidate] = []
    for tok in doc:
        head = tok.head
        if tok.dep_ in ("det", "amod") and head.pos_ in ("NOUN", "PROPN") and language != "en":
            feat = _mismatch(tok, head, ("Gender", "Number"))
            if feat:
                out.append(_cand(tok, head, feat, 0.45))
        elif tok.dep_ == "nsubj" and head.pos_ in ("VERB", "AUX") and tok.pos_ in ("PRON", "NOUN"):
            feats = ("Number", "Person") if tok.pos_ == "PRON" else ("Number",)
            feat = _mismatch(tok, head, feats)
            if feat:
                out.append(_cand(head, tok, feat, 0.4))
    return out


def _cand(tok, other, feat: str, confidence: float) -> Candidate:
    return Candidate(
        start=tok.idx,
        end=tok.idx + len(tok.text),
        original=tok.text,
        replacement=None,
        source="agreement",
        confidence=confidence,
        kind="agreement",
        message=f"'{tok.text}' and '{other.text}' disagree in {feat.lower()}.",
        extra={"feature": feat, "linked": other.text},
    )
