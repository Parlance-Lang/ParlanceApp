"""Shared candidate-edit shape used by every signal and the combiner."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Candidate:
    start: int
    end: int
    original: str
    replacement: str | None
    source: str
    confidence: float
    kind: str = "grammar"
    message: str = ""
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def locate(text: str, original: str, used: set[int]) -> int:
    """First occurrence of `original` not already claimed, or -1."""
    if not original:
        return -1
    for hay, needle in ((text, original), (text.lower(), original.lower())):
        idx = hay.find(needle)
        while idx >= 0:
            if idx not in used:
                return idx
            idx = hay.find(needle, idx + 1)
    return -1
