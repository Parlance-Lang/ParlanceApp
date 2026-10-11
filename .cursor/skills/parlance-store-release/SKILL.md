---
name: parlance-store-release
description: >-
  Ship Parlance to TestFlight, Google Play, GitHub Releases, #whats-new,
  and Claire in #announcements. Use when the user asks to bump, release,
  archive, Fastlane, TestFlight, Play Console, GitHub release, what's new,
  or a Discord announcement.
---

# Dual-store release

You are the engineer. Bump, build, upload both stores, publish the GitHub
release, and make sure Discord updates. Do not hand the user a checklist.
Do not ask them to run the commands.

One build number, both phones, one GitHub release, two Discord posts.

## Order

1. Bump, commit, push
2. `fastlane both` from the repo root (Play, then iOS)
3. Publish a GitHub release (that fires Discord)
4. Confirm #whats-new and Claire in #announcements

## Version

```bash
python3 scripts/bump_version.py --build
```

One build number per upload, both platforms. Never edit the four version
files by hand. Commit and push the bump before you upload.

Do not commit GGUF, MLX weights, `android/play-service-account.json`,
`android/keystore.properties`, or `google-services.json`.

## One web snapshot

`Parlance/web/` is the only frontend. `fastlane both` runs `scripts/sync_web.py`
then copies that folder into Android and archives iOS. Do not upload one store
and then change a guide before uploading the other. If the web changed after
one store already shipped that build number, bump and run `fastlane both`.

## Both stores (this Mac)

```bash
fastlane both
```

That is sync web, Play, then iOS, from `fastlane/Fastfile`.

- Android: `npx cap copy android`, strip `*.gguf` from the base module,
  `bundleRelease`, Play internal via `android/play-service-account.json`
  (`play-publisher@parlance-926ef.iam.gserviceaccount.com`). That account
  must already be a Play Console user with release access.
- iOS: local archive and upload. Xcode Cloud cannot see the MLX weights.
  `build/ExportOptions.plist` is `app-store-connect`, destination `upload`,
  team `9869W49GYJ`. Run `./training/prepare_ios_coach_model.sh` first and
  confirm the archived `.app` is under 4 GB (`du -sh` on
  `build/Parlance.xcarchive/Products/Applications/*.app`); App Store
  Connect rejects larger builds after upload with error 90558. Keep about
  10 GB of disk free: the export copies the app and writes a 3 GB IPA.

After `npx cap sync`, confirm `android/settings.gradle` still includes
`:parlance_models`.

Single store only: `fastlane android` or `fastlane ios`.

Internal tester link:
https://play.google.com/apps/internaltest/4701648803954304490

## GitHub release

Community notes only. No Archive, Still open, or archive steps.

```bash
python3 scripts/bump_version.py --show
# marketing 2.4, build 25 → tag v2.4.25, title Parlance 2.4 (25)
gh release create "v${MARKETING}.${BUILD}" \
  --title "Parlance ${MARKETING} (${BUILD})" \
  --notes-file /tmp/parlance-release-notes.md
```

Notes template (plain text, no em or en dashes):

```
Parlance MARKETING (BUILD) is on TestFlight and Play internal testing.

- Community facing change
- Community facing change

iPhone: update in TestFlight
Android: https://play.google.com/apps/internaltest/4701648803954304490
```

Publishing the release runs `.github/workflows/release-notify.yml`:
detailed notes to #whats-new, short Claire post to #announcements.

## Discord

Claire owns #announcements. #whats-new gets the longer notes.

If the GitHub Action posted, you are done. If it failed, post the same
split yourself with the webhooks (`DISCORD_RELEASE_WEBHOOK` = what's-new,
`DISCORD_ANNOUNCE_WEBHOOK` = Claire). Follow `discord-messaging-style.mdc`
and `discord-claire-announcements.mdc`.

Herald (`scripts/discord_bots/herald.py`) `/release` also posts both
channels when Claire is running. Prefer the GitHub release so Pages and
Discord stay in lockstep.

Do not post #announcements as Morgan, Jordan, or a generic Updates webhook.
Do not dump Archive / Still open into either channel.

## Do not

- Bump iOS and Android to different build numbers
- Upload from Xcode Cloud
- Switch frameworks to ship both stores
- Leave a store upload without a GitHub release and Claire announcement
