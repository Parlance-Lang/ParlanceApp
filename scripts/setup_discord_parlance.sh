#!/usr/bin/env bash
# Set up Parlance Discord server channels via Docker MCP (mcox profile).
#
# Prerequisites:
#   1. Docker Desktop MCP Toolkit with mcox profile (mcp-discord)
#   2. Valid bot token: echo "YOUR_BOT_TOKEN" | docker mcp secret set discord.token
#   3. Bot invited to your server with Manage Channels + Send Messages
#   4. Guild ID (right-click server icon → Copy Server ID, with Developer Mode on)
#
# Usage:
#   ./scripts/setup_discord_parlance.sh <guild-id>
#   ./scripts/setup_discord_parlance.sh <guild-id> --dry-run

set -euo pipefail

PROFILE=mcox
GUILD_ID="${1:-}"
DRY_RUN=false

if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if [[ -z "$GUILD_ID" ]]; then
  echo "Usage: $0 <guild-id> [--dry-run]" >&2
  exit 1
fi

mcp() {
  docker mcp tools call "$@" --gateway-arg --profile="$PROFILE" --format json
}

echo "Logging in to Discord..."
if ! mcp discord_login 2>&1 | grep -qi 'success\|logged'; then
  login_out="$(mcp discord_login 2>&1 || true)"
  if echo "$login_out" | grep -qi 'invalid token'; then
    echo "ERROR: Discord token is invalid. Set a new one:" >&2
    echo '  echo "YOUR_BOT_TOKEN" | docker mcp secret set discord.token' >&2
    exit 1
  fi
  echo "$login_out"
fi

echo "Fetching server info for guild $GUILD_ID..."
server_info="$(mcp discord_get_server_info "guildId=$GUILD_ID" 2>&1)" || {
  echo "ERROR: Could not read server. Check guild ID and bot permissions." >&2
  echo "$server_info" >&2
  exit 1
}

echo "$server_info" | head -c 500
echo ""

# channel_name|topic
CHANNELS=(
  "rules|Read before posting. Be respectful. No spam. This is a writing-practice community for aspiring interpreters."
  "announcements|Product updates, TestFlight builds, and release notes for Parlance."
  "general|Community chat for Parlance users and aspiring interpreters."
  "introductions|Tell us your target language(s), CEFR level, and what you're working toward (DELE, DELF, booth, etc.)."
  "support|Help with the Parlance app — install issues, sign-in, AI settings, and usage questions."
  "feedback|Feature ideas and product feedback. Vote with reactions on ideas you want."
  "bugs|Bug reports — include device/OS, Parlance version, language, and steps to reproduce."
  "spanish-practice|Share Spanish writing practice. DELE-oriented feedback welcome. Use Parlance Coach when you can."
  "french-practice|Share French writing practice. DELF-oriented feedback welcome. Use Parlance Coach when you can."
  "beta-testers|TestFlight and early-access discussion. Share what broke and what helped."
  "parlance-coach|Tips for on-device Parlance Coach, cloud AI, journal workflow, and exam prep."
)

WELCOME_MSG=$'Welcome to **Parlance** — a language writing journal for aspiring interpreters.\n\nPractice Spanish and French with structured AI feedback. Start in **#introductions**, get help in **#support**, and share writing in **#spanish-practice** or **#french-practice**.\n\nApp: https://parlance-lang.github.io/ParlanceApp/'

create_channel() {
  local name="$1"
  local topic="$2"
  if $DRY_RUN; then
    echo "[dry-run] would create #$name — $topic"
    return 0
  fi
  echo "Creating #$name..."
  mcp discord_create_text_channel \
    "guildId=$GUILD_ID" \
    "channelName=$name" \
    "topic=$topic" || echo "  (may already exist — skipping)"
}

post_welcome() {
  local channel_id="$1"
  if $DRY_RUN; then
    echo "[dry-run] would post welcome to channel $channel_id"
    return 0
  fi
  mcp discord_send "channelId=$channel_id" "message=$WELCOME_MSG" || true
}

for entry in "${CHANNELS[@]}"; do
  IFS='|' read -r name topic <<< "$entry"
  create_channel "$name" "$topic"
done

echo ""
echo "Done. Re-run discord_get_server_info to see channel IDs, then post welcome in #general manually if needed:"
echo "  docker mcp tools call discord_get_server_info guildId=$GUILD_ID --gateway-arg --profile=$PROFILE"
