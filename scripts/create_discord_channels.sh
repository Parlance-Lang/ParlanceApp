#!/usr/bin/env bash
# Create Parlance Discord channels via REST API (bot must already be in guild).
set -euo pipefail

GUILD_ID="${1:-1519729833079210064}"
TOKEN="${DISCORD_TOKEN:?Set DISCORD_TOKEN}"

api() {
  local method="$1" path="$2" data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -sS -X "$method" \
      -H "Authorization: Bot $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$data" \
      "https://discord.com/api/v10$path"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bot $TOKEN" \
      "https://discord.com/api/v10$path"
  fi
}

echo "Checking guild access..."
guild="$(api GET "/guilds/$GUILD_ID")"
if echo "$guild" | grep -q '"code"'; then
  echo "ERROR: Bot cannot access guild $GUILD_ID" >&2
  echo "$guild" >&2
  exit 1
fi
echo "Connected to: $(echo "$guild" | python3 -c 'import sys,json; print(json.load(sys.stdin)["name"])')"

create_channel() {
  local name="$1" topic="$2"
  existing="$(api GET "/guilds/$GUILD_ID/channels")"
  if echo "$existing" | python3 -c "import sys,json; names={c['name'] for c in json.load(sys.stdin)}; sys.exit(0 if '$name' in names else 1)" 2>/dev/null; then
    echo "  #$name already exists — skip"
    return 0
  fi
  payload=$(python3 -c "import json; print(json.dumps({'name':'$name','type':0,'topic':'''$topic'''}))")
  result="$(api POST "/guilds/$GUILD_ID/channels" "$payload")"
  if echo "$result" | grep -q '"code"'; then
    echo "  ERROR creating #$name: $result" >&2
    return 1
  fi
  echo "  Created #$name"
}

CHANNELS=(
  "rules|Read before posting. Be respectful. No spam. Writing-practice community for aspiring interpreters."
  "announcements|Product updates, TestFlight builds, and release notes for Parlance."
  "introductions|Share your target language(s), CEFR level, and goals (DELE, DELF, booth, etc.)."
  "support|Help with the Parlance app — install, sign-in, AI settings, and usage."
  "feedback|Feature ideas and product feedback."
  "bugs|Bug reports — include device/OS, version, language, and steps to reproduce."
  "spanish-practice|Spanish writing practice. DELE-oriented feedback welcome."
  "french-practice|French writing practice. DELF-oriented feedback welcome."
  "beta-testers|TestFlight and early-access discussion."
  "parlance-coach|Tips for Parlance Coach, cloud AI, journal workflow, and exam prep."
)

for entry in "${CHANNELS[@]}"; do
  IFS='|' read -r name topic <<< "$entry"
  create_channel "$name" "$topic"
done

GENERAL_ID="$(api GET "/guilds/$GUILD_ID/channels" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not isinstance(data, list):
    sys.exit(0)
ch = [c for c in data if isinstance(c, dict) and c.get('name') == 'general']
print(ch[0]['id'] if ch else '')
")"
if [[ -n "$GENERAL_ID" ]]; then
  WELCOME='Welcome to **Parlance** — a language writing journal for aspiring interpreters.\n\nPractice Spanish and French with structured AI feedback. Introduce yourself in **#introductions**, get help in **#support**, and share writing in **#spanish-practice** or **#french-practice**.\n\nApp: https://parlance-lang.github.io/ParlanceApp/'
  msg=$(python3 -c "import json; print(json.dumps({'content': '''$WELCOME'''}))")
  api POST "/channels/$GENERAL_ID/messages" "$msg" >/dev/null
  echo "Posted welcome message in #general"
fi

echo "Done."
