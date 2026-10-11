#!/usr/bin/env python3
"""Find (and optionally fix) outdated Parlance site links across the Discord server.

Scans every text and announcement channel's topic, pinned messages, and recent
history for OLD_PATTERNS. Reports each hit and whether it can be fixed:

- channel topics: the bot needs Manage Channels
- messages the bot itself posted: always editable
- messages posted by a webhook whose URL is in DISCORD_ANNOUNCE_WEBHOOK or
  DISCORD_RELEASE_WEBHOOK: editable through that webhook
- anything posted by a person: report only (Discord does not allow editing it)

  DISCORD_GUIDE_TOKEN=... python3 scripts/discord_bots/fix_site_links.py          # report
  DISCORD_GUIDE_TOKEN=... python3 scripts/discord_bots/fix_site_links.py --fix    # rewrite

Run from GitHub Actions: workflow "Discord: fix site links".
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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from discord_bots.config import GUILD_ID

BASE = "https://discord.com/api/v10"
NEW_SITE = "https://parlance-lang.github.io/ParlanceApp/"
REPLACEMENTS = [
    (re.compile(r"https?://montrez\.github\.io/ParlanceApp/?", re.I), NEW_SITE),
    (re.compile(r"github\.com/Montrez/ParlanceApp", re.I), "github.com/Parlance-Lang/ParlanceApp"),
]
OLD_PATTERNS = [p for p, _ in REPLACEMENTS]
HISTORY_CAP = 300
TEXT_TYPES = {0, 5}


def request(method: str, url: str, data: dict | None = None, auth: bool = True) -> dict | list:
    headers = {"Content-Type": "application/json", "User-Agent": "ParlanceLinkFix/1.0"}
    if auth:
        headers["Authorization"] = f"Bot {os.environ['DISCORD_GUIDE_TOKEN']}"
    body = None if data is None else json.dumps(data).encode()
    for _ in range(5):
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            payload = {}
            try:
                payload = json.loads(e.read().decode() or "{}")
            except json.JSONDecodeError:
                pass
            if e.code == 429:
                time.sleep(float(payload.get("retry_after", 1)) + 0.25)
                continue
            payload["_status"] = e.code
            return payload
    return {"_status": 429}


def api(method: str, path: str, data: dict | None = None) -> dict | list:
    return request(method, f"{BASE}{path}", data)


def rewrite(text: str) -> str:
    for pattern, new in REPLACEMENTS:
        text = pattern.sub(new, text)
    return text


def has_old(text: str | None) -> bool:
    return bool(text) and any(p.search(text) for p in OLD_PATTERNS)


def embeds_have_old(embeds: list) -> bool:
    return has_old(json.dumps(embeds))


def webhooks_from_env() -> dict[str, str]:
    """webhook id -> full webhook URL"""
    out = {}
    for var in ("DISCORD_ANNOUNCE_WEBHOOK", "DISCORD_RELEASE_WEBHOOK"):
        url = (os.environ.get(var) or "").strip()
        m = re.search(r"/webhooks/(\d+)/", url)
        if m:
            out[m.group(1)] = url.split("?")[0]
    return out


def channel_messages(channel_id: str) -> list[dict] | None:
    """None when the bot cannot read the channel."""
    seen: dict[str, dict] = {}
    pins = api("GET", f"/channels/{channel_id}/pins")
    if not isinstance(pins, list):
        return None
    for m in pins:
        seen[m["id"]] = m
    before = None
    fetched = 0
    while fetched < HISTORY_CAP:
        q = f"?limit=100" + (f"&before={before}" if before else "")
        batch = api("GET", f"/channels/{channel_id}/messages{q}")
        if not isinstance(batch, list) or not batch:
            break
        for m in batch:
            seen.setdefault(m["id"], m)
        fetched += len(batch)
        before = batch[-1]["id"]
        if len(batch) < 100:
            break
    return list(seen.values())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="rewrite everything the bot is allowed to edit")
    args = ap.parse_args()

    me = api("GET", "/users/@me")
    if "id" not in me:
        print(f"Token check failed: {me}", file=sys.stderr)
        return 1
    hooks = webhooks_from_env()
    channels = api("GET", f"/guilds/{GUILD_ID}/channels")
    if not isinstance(channels, list):
        print(f"Could not list channels: {channels}", file=sys.stderr)
        return 1

    found = fixed = manual = scanned = checked = 0
    unreadable: list[str] = []
    for ch in sorted(channels, key=lambda c: c.get("position", 0)):
        if ch.get("type") not in TEXT_TYPES:
            continue
        name = f"#{ch['name']}"

        if has_old(ch.get("topic")):
            found += 1
            if args.fix:
                r = api("PATCH", f"/channels/{ch['id']}", {"topic": rewrite(ch["topic"])})
                ok = "_status" not in r
                fixed += ok
                manual += not ok
                print(f"{name} topic: {'fixed' if ok else 'FAILED ' + str(r.get('message'))}")
            else:
                print(f"{name} topic: outdated link")

        messages = channel_messages(ch["id"])
        if messages is None:
            unreadable.append(name)
            continue
        scanned += 1
        checked += len(messages)
        for m in messages:
            content, embeds = m.get("content") or "", m.get("embeds") or []
            if not (has_old(content) or embeds_have_old(embeds)):
                continue
            found += 1
            author = m.get("author", {})
            where = f"{name} message {m['id']} by {author.get('username', '?')}"
            patch = {}
            if has_old(content):
                patch["content"] = rewrite(content)
            if embeds_have_old(embeds):
                patch["embeds"] = json.loads(rewrite(json.dumps(embeds)))

            if author.get("id") == me["id"]:
                target = f"{BASE}/channels/{ch['id']}/messages/{m['id']}"
                auth = True
            elif m.get("webhook_id") in hooks:
                target = f"{hooks[m['webhook_id']]}/messages/{m['id']}"
                auth = False
            else:
                manual += 1
                print(f"{where}: needs a manual edit (posted by a person or another bot)")
                continue

            if not args.fix:
                print(f"{where}: outdated link (fixable)")
                continue
            r = request("PATCH", target, patch, auth=auth)
            ok = "_status" not in r
            fixed += ok
            manual += not ok
            print(f"{where}: {'fixed' if ok else 'FAILED ' + str(r.get('message'))}")

    print(f"\nScanned {scanned} channels, {checked} messages.")
    if unreadable:
        print(f"Could not read (bot lacks access): {', '.join(unreadable)}")
    mode = "fixed" if args.fix else "fixable"
    print(f"\nOutdated links found: {found}. {mode.capitalize()}: {fixed if args.fix else found - manual}. Manual: {manual}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
