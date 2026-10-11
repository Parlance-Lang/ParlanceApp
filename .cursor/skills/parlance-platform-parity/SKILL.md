---
name: parlance-platform-parity
description: >-
  Keep the iOS and Android Parlance apps on one web frontend. Use when
  editing Parlance/web, docs/, Capacitor, Android, overlay z-index, the
  native bridge, check_platform_sync.py, or when a change works on one
  phone and not the other.
---

# Parlance platform parity

One web frontend. Two native hosts. Do not fork the UI.

## Sources of truth

| Layer | Where |
|---|---|
| Journal, settings, guides, CSS, JS | `Parlance/web/` only |
| iOS | WKWebView loads the Xcode-bundled `Parlance/web/` |
| Android | Capacitor `webDir` is `Parlance/web/` (`npx cap copy android`) |
| GitHub Pages | generated `docs/` via `python3 scripts/sync_web.py` |

Never edit app UI in `docs/`. Never ship one phone from a different web snapshot than the other.

## After every shared-frontend change

```
parity progress:
- [ ] Edited Parlance/web/ only
- [ ] python3 scripts/sync_web.py
- [ ] python3 scripts/check_platform_sync.py
- [ ] python3 scripts/check_guide_i18n.py
- [ ] npx cap copy android   (if Android will run the change)
```

`check_platform_sync.py` also fails when iOS and Android version numbers drift. Bump versions only with `python3 scripts/bump_version.py`.

## Overlay z-index

Phone chrome and overlays share one stack. Do not lower these.

| Surface | z-index |
|---|---|
| Phone coaching sheet (`.feedback-panel`) | 250 |
| Journal entry viewer (`#entryOverlay`) | 300 |
| Guide iframe (`#guideOverlay`) | 400 |

A guide is open when `body` has `guide-open`. That class must hide `.feedback-panel` and `.feedback-sheet-backdrop` so Contents / Back are not covered by FEEDBACK / PROMPTS / GUIDE.

## Native bridge

`journal.js` posts `{action: ...}` and waits on `window.__parlance*`. Both hosts implement the same actions. If you add an action on one side, add it on the other or list it in `IOS_ONLY_ACTIONS` in `check_platform_sync.py` with a reason.

Coach on both phones is `analyzeParlanceSLM`. On iPhone, Spanish and French are both fused Gemma 4 GEC models (grammar-only prompt); their identical tensors ship once in `parlance-coach-shared` (see `training/split_coach_weights.py`) so the app stays under Apple's 4 GB limit. The rules engine is a post-pass, not a stand-in. Android GGUF files are gitignored; Spanish GGUF from `training/export_parlance_gguf.py`, French from the fused Gemma export when that file exists. Play ships them in the `parlance_models` fast-follow asset pack (install-time is capped at 1 GB; French Gemma does not fit). Before a Play `bundleRelease`, remove `android/app/src/main/assets/models/*.gguf` so the base module stays under Play's size limit. The Java API is `net.ladenthin:llama` (the `llama-android` AAR is not on Maven Central). After `npx cap sync`, confirm `android/settings.gradle` still includes `:parlance_models`.

## Do not

- Sniff `platform === 'android'` in `journal.js` to hide a feature the other host already has
- Upload model weights to Firebase Storage
- Treat the rules engine as the coach
- Edit version numbers by hand
