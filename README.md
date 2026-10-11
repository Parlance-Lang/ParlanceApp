<p align="center">
  <img src="docs/logo.png" alt="Parlance" width="120" />
</p>

<h1 align="center">Parlance</h1>

<p align="center">
  A language writing journal for aspiring interpreters.<br>
  Practice writing in English, Spanish, and French with on-device Coach feedback.
</p>

<p align="center">
  <a href="https://github.com/Montrez/ParlanceApp/releases/latest">
    <img src="https://img.shields.io/github/v/release/Montrez/ParlanceApp?label=release" alt="Latest release" />
  </a>
  <a href="https://montrez.github.io/ParlanceApp/">
    <img src="https://img.shields.io/badge/web%20app-live-0b9cd0" alt="Web app live" />
  </a>
</p>

---

## What's in the app

- **Journal**: write sentences in English, Spanish, or French and get structured Coach feedback (corrections, register, CEFR level, higher-level rephrasings) as you go.
- **Grammar Guide**: verb tenses and grammar rules, A1–C2, per practice language.
- **Regional Guide**: regional vocabulary, pronouns, and dialect traps, with a "your region vs. theirs" picker.
- **Medical and Legal Guides**: domain interpreting references. On the phones these two require Parlance Plus.
- **Parlance Coach**: on-device grammar coaching for English, Spanish, and French. Runs fully offline (Gemma 4 GEC via MLX on iPhone, Qwen 0.5B GGUF on Android). Phones are Coach-only. The web app can still use a cloud provider.
- **Parlance Plus**: monthly subscription. On the phones it unlocks the medical and legal guides. Writing and saving journal entries stay free. Coach feedback is what we charge for.
- Dark mode and interface language (EN/ES/FR) that apply across the journal, guides, and regional content.

No account is required on the phones. Purchases go through the App Store or Google Play. Restore purchase is on the AI settings sheet.

---

## Quick Start

### iOS

```bash
git clone https://github.com/Montrez/ParlanceApp.git
cd ParlanceApp
open Parlance.xcodeproj
```

1. Set your signing team under **Signing & Capabilities**
2. Connect your device or pick a simulator
3. **Run** (Cmd+R)

### Web

Visit the [GitHub Pages site](https://montrez.github.io/ParlanceApp/) — no install needed. The web app can run AI in-browser with WebLLM or connect a cloud provider. The iPhone and Android apps use Parlance Coach on the device.

### Android

```bash
npx cap sync android
```

Open `android/` in Android Studio and run on a device or emulator.

Android and iOS share the web layer in `Parlance/web/` (mirrored to `docs/`, which
Capacitor bundles). Each platform supplies a native bridge behind the same message
protocol — `Parlance/ContentView.swift` on iOS, `ParlanceBridge.java` on Android —
so a feature added to one is expected on the other.
`python3 scripts/check_platform_sync.py` fails the build if a bridge action or
version number only lands on one side.

Capabilities that genuinely differ are reported by the bridge rather than sniffed
in JavaScript. Both phones report `inAppPurchase: true` (StoreKit on iOS, Play
Billing on Android) and `coachOnly: true`. AI settings live in the shared web
layer so both phones stay on one layout.

**Google Sign-In requires registered SHA-1 fingerprints.** Credential Manager will
not issue an ID token for an app whose signing certificate is unknown to Firebase,
and the failure surfaces as a generic sign-in error. Register every certificate the
app can be signed with:

```bash
# Debug builds
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android

# Local release builds
keytool -list -v -keystore android/parlance-release.jks -alias parlance
```

Add each SHA-1 in Firebase Console → Project Settings → Your apps → Android, then
re-download `google-services.json` into `android/app/`. Builds distributed through
Play use **Play App Signing**, so the certificate in Play Console → Setup → App
integrity must be registered too — otherwise sign-in works locally and fails for
everyone who installs from Play.

Release signing credentials are read from `android/keystore.properties`, which is
gitignored. Copy `android/keystore.properties.example` and fill it in, or export
`PARLANCE_KEYSTORE_FILE`, `PARLANCE_KEYSTORE_PASSWORD`, `PARLANCE_KEY_ALIAS`, and
`PARLANCE_KEY_PASSWORD`. Without them the project still builds debug and unsigned
release.

### Versioning

Never edit a version by hand. Four files carry one, and editing them separately
is how iOS and Android drift apart:

```bash
python3 scripts/bump_version.py --show           # current numbers
python3 scripts/bump_version.py --build          # build + 1, both platforms
python3 scripts/bump_version.py --marketing 2.5  # the string humans see
```

The script refuses to run if the files already disagree, and refuses to move a
build number downwards, because no store lets you reuse or lower one.
`scripts/check_platform_sync.py` enforces the same match in CI.

Bump the build **once per upload**, whether it goes to TestFlight, Play, or both.
The marketing version only changes when the release is worth a new number to a
user; a rejected submission can be resubmitted under the same one.

Ship both stores from this Mac with `fastlane both` (see [fastlane/README.md](fastlane/README.md)). Do not upload from Xcode Cloud; it cannot see the Coach weights.

---

## Parlance Coach

On-device grammar coaching on **iPhone and Android**. iPhone runs fine-tuned Gemma 4 GEC models for Spanish and French (MLX); English uses the Spanish model with English prompts and the English rules pack. Android runs the fine-tuned Qwen 0.5B GGUF exports. See [training/ARCHIVE_SPANISH.md](training/ARCHIVE_SPANISH.md).

1. iOS: `./training/prepare_ios_coach_model.sh` (stages both Gemma models and splits out their shared weights so the app stays under Apple's 4 GB limit), then archive locally
2. Android: GGUF exports live in the `parlance_models` Play asset pack, not the base module
3. In the app: set **Write** to English, Spanish, or French and tap **Feedback**

Optional Mac dev server: `python3 training/parlance_slm_server.py`.

## Cloud AI (web only)

The phones do not take an API key. On GitHub Pages you can still use a cloud provider. The default there is **Groq** (free, fast). Get a key at [console.groq.com/keys](https://console.groq.com/keys) and set it in **AI Settings**.

Supported on the web: Groq, OpenAI, Anthropic, Google Gemini, DeepSeek, Kimi, OpenRouter, and in-browser WebLLM.

---

## How It Works

1. Write a sentence in your target language
2. Parlance selects relevant grammar rules, exam context (DELE/DELF), and domain terminology via RAG
3. An AI model returns structured feedback: corrections, register analysis, higher-level rephrasings, and interpreter tips

Feedback infers the sentence’s CEFR level (A1–C2) when the model is confident, plus a complexity note when it isn’t. Register identification and professional phrasing for medical, legal, and conference interpreting are included.

---

## Roadmap

Active work is tracked as GitHub issues, grouped into epics:

- [English learning path](https://github.com/Montrez/ParlanceApp/issues/9) — journal and Coach already cover English; dedicated English weights are still open
- [Language architecture](https://github.com/Montrez/ParlanceApp/issues/12) — making it easier to add new languages and sections
- [Central design system](https://github.com/Montrez/ParlanceApp/issues/16) — one source of truth for colors across web, native, and the app icon
- [App layout & UX polish](https://github.com/Montrez/ParlanceApp/issues/20)
- [Coach model quality](https://github.com/Montrez/ParlanceApp/issues/26)

See the [full issue list](https://github.com/Montrez/ParlanceApp/issues) for everything currently open.

---

*Built with a shared web frontend, SwiftUI + WKWebView on iPhone, Capacitor on Android, and on-device Parlance Coach*
