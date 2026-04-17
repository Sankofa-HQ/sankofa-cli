# Sankofa CLI

The command-line tool for [Sankofa](https://sankofa.dev) — analytics, OTA updates, and crash reporting for mobile and web apps. One CLI to set up, verify, and ship across every platform Sankofa supports.

**Deploy** — Ship JavaScript changes to your React Native / Expo apps without cutting a new native build. CodePush-style OTA with phased rollouts, auto-rollback, and a kill switch.

**Analytics** — Event tracking, session replays, heatmaps, and funnels. Works on React Native, Flutter, Web (npm and CDN), iOS (Swift), and Android (Kotlin).

**Check** — Verify your SDK integration is correct across any platform before you ship.

---

## Table of contents

1. [What the CLI does](#what-the-cli-does)
2. [Supported platforms](#supported-platforms)
3. [Install](#install)
4. [Concepts](#concepts)
5. [Quickstart](#quickstart)
6. [Authentication & config](#authentication--config)
7. [Commands](#commands)
    - [`init`](#init)
    - [`check`](#check)
    - [`doctor`](#doctor)
    - [`login`](#login)
    - [`logout`](#logout)
    - [`switch`](#switch)
    - [`status`](#status)
    - [`release`](#release)
    - [`patch`](#patch)
    - [`preview`](#preview)
    - [`dist`](#dist)
    - [`submit`](#submit)
8. [The release pipeline in detail](#the-release-pipeline-in-detail)
9. [Asset handling (fonts, images, videos…)](#asset-handling-fonts-images-videos)
10. [Rollout, rollback, and crash reporting](#rollout-rollback-and-crash-reporting)
11. [Signing (iOS + Android)](#signing-ios--android)
12. [CI/CD](#cicd)
13. [Troubleshooting](#troubleshooting)
14. [Environment variables](#environment-variables)

---

## What the CLI does

### Setup & Diagnostics

| Command | Purpose | Platforms |
|---|---|---|
| `sankofa init` | Auto-detect platform, create `.sankofa.json`, patch native files (Expo plugin / bare RN / Flutter / iOS / Android / Web), update `.gitignore`. | All |
| `sankofa check` | Verify the full SDK integration — credentials, native wiring, initialization, tracking, server connectivity. Shows exactly what to fix. | All |
| `sankofa check analytics` | Analytics-specific checks: SDK install, `init()`, API key, session replay, screen/event tracking, user identification. | All |
| `sankofa check deploy` | Deploy-specific checks: bundle provider, Expo plugin, `notifyAppReady()`, `checkForUpdate()`. | React Native |
| `sankofa doctor` | Diagnose the local toolchain (Node, Xcode, CocoaPods, Java, Android SDK, adb, altool) and server reachability. | React Native |

### Authentication

| Command | Purpose |
|---|---|
| `sankofa login` | Browser-based auth; creates a Deploy Token for the selected project and persists a session JWT for later `switch`es. |
| `sankofa logout` | Remove stored credentials (project-scoped, global, or both). |
| `sankofa switch` | Switch to a different project on the same server. Reuses the stored JWT — no browser round-trip. |

### Deploy (React Native)

| Command | Purpose |
|---|---|
| `sankofa release` | Build native + stage OTA archive + publish base release + produce signed store binary (`.ipa` / `.aab`). |
| `sankofa patch` | Ship a JS+assets-only OTA patch against an existing base release. |
| `sankofa preview` | Download + install + launch a release on a simulator/emulator. Streams runtime logs. |
| `sankofa status` | Read-only summary of all releases for the current project. |
| `sankofa releases` | Manage base releases: `list`, `rollout`, `mandatory`, `kill`, `unkill`. |
| `sankofa patches` | Manage patches: `list`, `rollout`, `mandatory`, `kill`, `unkill`. |
| `sankofa dist` | Build ONLY the signed store binary. No Sankofa release is published. |
| `sankofa submit` | Upload the signed binary to App Store Connect (iOS) or Play Console (Android). |
| `sankofa upgrade` | Check npm for a newer `sankofa-cli` and install it. |

Every command that hits the server short-circuits with a clean "you are not logged in" message when credentials are missing — no stray prompts before the auth check.

---

## Supported platforms

`sankofa init` and `sankofa check` auto-detect the platform from the project root:

| Platform | Detection | SDK Package | `init` does | `check analytics` validates |
|---|---|---|---|---|
| **React Native (Expo)** | `expo` in package.json | `sankofa-react-native` | Adds config plugin to app.json | SDK, init, API key, replay, `useSankofaScreen()`, events |
| **React Native (bare)** | `react-native` in package.json | `sankofa-react-native` | Patches `MainApplication.kt` + `AppDelegate.swift` | Same as Expo |
| **Flutter** | `pubspec.yaml` exists | `sankofa_flutter` | Creates config, shows Dart setup | SDK, `Sankofa.instance.init()`, replay, `SankofaNavigatorObserver`, events, identify |
| **Web (npm)** | `react`/`next`/`vue`/`vite` in package.json | `@sankofa/browser` | Creates config, shows import setup | SDK, `Sankofa.init()`, API key, replay plugin, events, identify, page tracking |
| **Web (CDN)** | `index.html` exists, no package.json | `@sankofa/browser` (CDN) | Creates config, shows `<script>` setup | CDN script tag, `Sankofa.init()`, `SankofaReplay`, events, identify, screen |
| **iOS (Swift)** | `Package.swift` exists | `SankofaIOS` (SPM/CocoaPods) | Creates config, shows SPM setup | SPM/Pod dep, `Sankofa.shared.initialize()`, `.sankofaScreen()`, events, identify |
| **Android (Kotlin)** | `app/build.gradle` exists | `dev.sankofa.sdk:sankofa-android` | Creates config, shows Gradle setup | Gradle dep, `Sankofa.init()`, `@SankofaScreen`, events, identify |

---

## Install

```bash
# From this monorepo
cd cli/sankofa-cli
npm install
npm run build
npm link           # exposes `sankofa` on your PATH

# Or, once published:
npm install -g sankofa-cli
```

Requirements:

- **Node.js ≥ 18** (uses global `fetch`).
- **macOS + Xcode** for iOS builds (`xcodebuild`, `xcrun simctl`, `xcrun altool`, `/usr/libexec/PlistBuddy`, `ditto`).
- **Android SDK / Gradle / Java 17** for Android builds (`./gradlew`, `adb`, `aapt`).
- **CocoaPods** for iOS (`pod` or `bundle exec pod`).
- **`zip` / `unzip`** (standard on macOS + Linux).
- **Expo project**: the CLI runs `npx expo prebuild --platform <platform>` before every build to keep `Info.plist` / `build.gradle` in sync with `app.json`. Bare RN projects work too; prebuild is a no-op there.

---

## Concepts

- **Base release** — a release tied to a specific native binary version (e.g. `1.2.0`). Created with `sankofa release`.
- **Patch release** — a JavaScript-only update against an existing base release. Created with `sankofa patch`. No native rebuild required.
- **Rollout** — percentage of devices that receive a given release. Deterministic per device — increasing the percentage only adds new devices, never removes existing ones.
- **Mandatory update** — forces the app to download and apply immediately instead of waiting for next launch.
- **Kill switch** — instantly disables a release for all devices. Takes effect on next app launch.

---

## Quickstart

### Any platform (Analytics)

```bash
# 1. Set up the project.
sankofa init

# 2. Log in.
sankofa login

# 3. Verify everything is wired up.
sankofa check

# Done. Events flow to your Sankofa dashboard.
```

### React Native (Analytics + Deploy)

```bash
# 1. Set up — auto-patches native files + adds Expo plugin.
sankofa init

# 2. Log in.
sankofa login

# 3. Verify the full setup.
sankofa check

# 4. Ship the first release (OTA + signed store binary).
sankofa release ios
sankofa submit ios --apple-api-key-id ABC --apple-api-issuer UUID

# 5. After the store build is out, ship a JS/assets-only patch:
sankofa patch ios

# 6. Need to rebuild JUST the signed binary?
sankofa dist ios
sankofa submit ios
```

---

## Authentication & config

Credentials live in two places:

| File | Scope | Populated by |
|---|---|---|
| `~/.sankofa/credentials.json` | Global (any cwd) | `sankofa login` (default) |
| `<project>/.sankofa.json`     | Per-project | `sankofa login --project` |

Both can contain:

```json
{
  "token": "sk_deploy_…",
  "authType": "deploy_token",
  "apiKey": "sk_deploy_…",
  "endpoint": "https://api.sankofa.dev",
  "projectId": "proj_…",
  "environment": "live",
  "sessionJwt": "<short-lived JWT from browser login>"
}
```

Resolution order (highest wins):

1. Environment variables (`SANKOFA_DEPLOY_TOKEN`, `SANKOFA_ENDPOINT`, `SANKOFA_PROJECT_ID`, `SANKOFA_ENVIRONMENT`).
2. `.sankofa.json` found by walking up from `cwd`.
3. `~/.sankofa/credentials.json`.

**Deploy Tokens are project-scoped** on the server. Switching projects mints a new token. `sessionJwt` is persisted so `sankofa switch` doesn't need another browser round-trip until it expires.

---

## Commands

### `init`

Set up Sankofa in any project. Auto-detects the platform and does the right thing.

```bash
sankofa init                             # auto-detect platform, create config
sankofa init --endpoint https://api.sankofa.dev --project-id proj_...
sankofa init --force                     # overwrite existing .sankofa.json
```

**What it does per platform:**

- **React Native (Expo)** — creates `.sankofa.json`, updates `.gitignore`, adds `sankofa-react-native` to `app.json` plugins.
- **React Native (bare)** — same + patches `MainApplication.kt` and `AppDelegate.swift` with the OTA bundle provider. If patching fails, prints the exact code to add manually.
- **Flutter** — creates `.sankofa.json`, updates `.gitignore`, prints Dart initialization code.
- **Web** — creates `.sankofa.json`, updates `.gitignore`, prints CDN `<script>` or `npm install` instructions.
- **iOS / Android** — creates `.sankofa.json`, updates `.gitignore`, prints platform-specific SDK setup.

Idempotent — safe to run multiple times. Existing `.sankofa.json` is preserved unless `--force` is passed.

### `check`

Verify your entire Sankofa integration is correct. Run it before shipping, after updating the SDK, or when something breaks.

```bash
sankofa check                  # run all module checks for the detected platform
sankofa check analytics        # analytics-specific checks only
sankofa check deploy           # deploy-specific checks only (React Native)
```

Every failed check shows a `→ fix` command. Example output:

```
  Sankofa — Full Configuration Check
  Platform: React Native
  ──────────────────────────────────

  CREDENTIALS & SERVER
  ✓ Project config     project proj_abc123, env live
  ✓ CLI credentials    project proj_abc123
  ✓ Server reachable   https://api.sankofa.dev — responding

  ANALYTICS
  ✓ SDK installed          sankofa-react-native@0.1.0
  ✓ Sankofa.initialize()   app/_layout.tsx
  ✓ Session Replay         recordSessions configured
  ✓ Screen tracking        useSankofaScreen() found
  ✓ Event tracking         Sankofa.track() found
  ✓ Analytics API access   API key valid and accessible

  ✓ Analytics is fully configured and ready!

  DEPLOY
  ✓ SDK installed             sankofa-react-native@0.1.0
  ✓ Expo config plugin        sankofa-react-native in app.json plugins
  ✓ Android bundle provider   wired in MainApplication.kt
  ✓ iOS bundle provider       wired in AppDelegate.swift
  ✓ notifyAppReady()          health confirmation present
  ✓ checkForUpdate()          update check present
  ✓ Deploy API access         authenticated and accessible

  ✓ Deploy is fully configured and ready!
```

**Analytics checks** (all platforms): SDK installed, initialization found in source, API key validation (test vs live vs placeholder), session replay, screen/page tracking, event tracking, user identification, API key server verification.

**Deploy checks** (React Native only): Expo config plugin or native bundle provider patching, `notifyAppReady()`, `checkForUpdate()`, `.gitignore` coverage, authenticated API access.

### `doctor`

Low-level toolchain diagnostics. Checks Node, Xcode, CocoaPods, Java, Android SDK, and server reachability.

```bash
sankofa doctor
sankofa doctor --project /path/to/app
```

### `login`

```bash
sankofa login                                                 # interactive browser flow
sankofa login --project                                       # save to ./.sankofa.json instead of global
sankofa login --deploy-token sk_deploy_... --project-id proj_… # CI/CD, no browser
sankofa login --endpoint https://sankofa.your-company.com     # self-hosted
```

- Endpoints without a scheme are auto-normalized: `localhost:8080` → `http://localhost:8080`, `api.sankofa.dev` → `https://api.sankofa.dev`.
- `--deploy-token` is validated against `live` first, then `test`; the matching environment is saved so `status`/`release` don't have to prompt.

### `logout`

```bash
sankofa logout             # removes BOTH scopes (default)
sankofa logout --project   # only ./.sankofa.json  (also clears token+projectId from the global file)
sankofa logout --global    # only ~/.sankofa/credentials.json
sankofa logout --all       # explicit alias for the default; safe to use in scripts
```

- `--project` intentionally also strips `token`, `projectId`, and `environment` from the global file. Keeping a project-scoped token without a project id would silently reuse the old project on the next command. `sessionJwt` is left intact so a follow-up `switch` stays frictionless.
- A reminder prints about `SANKOFA_DEPLOY_TOKEN` / `SANKOFA_API_KEY` env vars — those still authenticate the CLI until you unset them in your shell.

### `switch`

```bash
sankofa switch
```

Uses the stored `sessionJwt` to `GET /api/auth/me`, lists your orgs + projects, prompts, mints a new Deploy Token for the selection, saves it. Falls back to the full browser login flow when the JWT is missing or expired. No args.

### `status`

```bash
sankofa status                       # prompts for env
sankofa status --env test
sankofa status --env live --platform ios
```

Prints each release's label, platform, target version, rollout %, install count, rollback count, and whether a kill-switch is active. Color-coded status tags (`ACTIVE`, `ROLLING OUT x%`, `MANDATORY`, `DISABLED`).

### `release`

Build + publish a **base release**.

Every `release` builds the native app, publishes the OTA update, and produces a signed store binary (`.ipa` / `.aab`) — all in one command. Pass `--skip-distribution` if you only need OTA.

```bash
sankofa release ios                                 # OTA + signed .ipa
sankofa release android                             # OTA + signed .aab

sankofa release ios --publish --env test --rollout 50 --description "Initial 1.2.0"

sankofa release ios --ios-export-method app-store --ios-team-id ABC1234XYZ
sankofa release android --android-format apk        # sideload APK instead of AAB

sankofa release ios --skip-distribution             # OTA only (rare)
```

**Arguments**

- `[platform]` — `ios` or `android`. Prompts interactively when omitted.

**OTA options**

- `--entry-file <file>` — JS entry file. Default: from `package.json`'s `main` (so Expo `expo-router/entry.js` works out-of-the-box).
- `--output-dir <dir>` — build output root. Default: `./build`.
- `--no-native-artifact` — skip building the preview `.app.zip`/`.apk`. Use only when you intentionally don't need `sankofa preview`.
- `--description <desc>` — release description (shown on the dashboard).
- `--mandatory` — force-update on every device.
- `--rollout <percent>` — 0–100. Default `100`. Non-100 starts a staged rollout immediately.
- `--publish` — skip the "are you sure?" prompt. Required in CI.
- `--env <live|test>` — overrides the env saved at login.
- `--project <path>` — path to the RN app directory if you run the CLI from outside it (monorepos).

**Distribution options (always on unless `--skip-distribution`)**

- `--skip-distribution` — OTA-only release. The warning at the end tells you how to produce the binary later with `sankofa dist`.
- `--ios-export-method <app-store|ad-hoc|development|enterprise>` — default `app-store`.
- `--ios-team-id <TEAMID>` — auto-detected from the archive when omitted.
- `--ios-export-options <path>` — a hand-rolled `ExportOptions.plist` (overrides `--ios-export-method` / `--ios-team-id`).
- `--android-format <aab|apk>` — default `aab` (Play Store). `apk` for sideload/legacy.

**When a release for this version already exists**

The CLI errors out (by design — OTA is immutable once published) and prints three escape hatches:
- `sankofa patch <platform>` — ship JS+assets against the existing base.
- `sankofa dist <platform>` — rebuild only the signed binary (OTA unchanged).
- `sankofa submit <platform>` — upload the binary you already built.

### `patch`

Ship a **JS + assets** update against an existing base release. No native code changes.

```bash
sankofa patch ios
sankofa patch ios --publish --rollout 100 --mandatory
```

**Arguments**

- `[platform]` — `ios` / `android` / prompt.

**Options**

- `--entry-file <file>`, `--output-dir <dir>`, `--description <desc>`, `--mandatory`, `--rollout <percent>`, `--publish`, `--env <env>`, `--project <path>` — same semantics as `release`.

`patch` prompts you to pick the base release it targets. Labels are auto-generated as `<base>-patch.<n>` where `<n>` is the next integer.

### `preview`

Download + install + launch a published release or patch on your local simulator/emulator.

```bash
sankofa preview ios
sankofa preview ios --label v1.2.0-patch.3
sankofa preview android --device <adb-serial>
sankofa preview ios --skip-install   # only downloads + verifies
sankofa preview ios --no-logs        # do not stream runtime logs
```

**Options**

- `--version <version>` — skip the version picker.
- `--label <label>` — pick a specific release.
- `--env <live|test>`.
- `--app-id <id>` — override the detected bundle identifier / package name.
- `--device <device>` — iOS simulator UDID/name or Android `adb` serial. Defaults to the booted simulator / default device.
- `--output-dir <dir>` — where to stage the downloaded artifacts.
- `--skip-install` — just download + verify, don't install.
- `--no-logs` — don't attach to the app's stdout after launch. Default: logs stream live via `xcrun simctl launch --console-pty` (iOS) or `adb logcat --pid=…` (Android). Ctrl+C detaches without killing the app.
- `--project <path>` — RN app root override.

The CLI downloads the release, installs it on the simulator/emulator, and configures the SDK to load the correct bundle on startup.

### `dist`

Build the signed store binary **without** publishing a Sankofa release.

Use when:
- A release for this version already exists but you need to rebuild the `.ipa` / `.aab` (fresh certs, corrupt archive, signing config change).
- Your CI ships OTA and store binaries on separate lanes.
- You want an explicit build → upload handoff (`sankofa dist` → review → `sankofa submit`).

```bash
sankofa dist ios
sankofa dist ios --ios-export-method ad-hoc --ios-team-id ABC1234XYZ
sankofa dist android --android-format aab
```

**Arguments**

- `[platform]` — `ios` / `android` / prompt.

**Options** (same signing/export options as `release`, minus OTA publishing)

- `--output-dir <dir>`
- `--project <path>`
- `--ios-export-method <method>`
- `--ios-team-id <id>`
- `--ios-export-options <path>`
- `--android-format <aab|apk>`

The OTA archive is **not** built or uploaded here. This command is purely a local build step.

### `submit`

Upload the signed distribution binary to the real store.

```bash
sankofa submit ios \
  --apple-api-key-id ABC1234XYZ \
  --apple-api-issuer 12345678-1234-1234-1234-1234567890ab

sankofa submit android \
  --google-service-account ~/secrets/play-sa.json \
  --google-track internal
```

**Arguments**

- `[platform]` — `ios` / `android` / prompt.

**Common**

- `--binary <path>` — override the auto-detected distribution output.
- `--project <path>` — RN app root override.

**iOS options**

- `--apple-api-key-id <id>` — App Store Connect API Key ID (10-char alphanumeric).
- `--apple-api-issuer <uuid>` — Issuer ID (UUID on the Keys page).
- `--apple-api-key-path <path>` — path to `AuthKey_<ID>.p8`. Default: `~/.appstoreconnect/private_keys/AuthKey_<ID>.p8`.

Runs `xcrun altool --validate-app` first, then `--upload-app`. Validation failures are fixed locally before the slow upload starts.

**Android options**

- `--google-service-account <path>` — service-account JSON key with Play Developer API access.
- `--google-track <internal|alpha|beta|production>` — default `internal`.
- `--google-package <name>` — overrides the `namespace` / `applicationId` detected from `build.gradle`.

Uses `googleapis` to: create an edit → upload `.aab`/`.apk` → set the chosen track → commit. Tracks default to `draft` except `production` which commits as `completed`.

---

## The release pipeline

Every `sankofa release <platform>` handles the full pipeline automatically:

1. **Auth check** — verifies credentials before any prompt.
2. **Version detection** — reads the native binary version and validates it matches `app.json`.
3. **Native build** — builds the app, extracts the JavaScript bundle and assets.
4. **Upload** — publishes the release to the Sankofa server with integrity verification.
5. **Distribution build** — produces a signed `.ipa` / `.aab` for store submission (unless `--skip-distribution`).

`sankofa patch` skips the native build — it bundles only JavaScript and assets for a lightweight OTA update.

---

## Asset handling (fonts, images, videos…)

Sankofa Deploy ships assets alongside the JavaScript bundle — fonts, images, and any other resources referenced by your code survive OTA patches automatically. No additional configuration needed.

---

## Rollout, rollback, and crash reporting

- **Rollout** — phased rollouts let you ship to a small percentage of users first, then increase gradually. The rollout is deterministic — increasing the percentage only adds devices, never removes ones that already received the update.
- **Auto-rollback** — if the app crashes repeatedly after an OTA update, the SDK automatically reverts to the previous working bundle.
- **Kill switch** — instantly disable a release for all users from the dashboard or CLI.
- **Crash monitoring** — the dashboard tracks crash rates per release. Staged rollout schedules can auto-pause or auto-halt when crash rates exceed configured thresholds.
- **Error reporting** — use `deploy.reportError(err, { fatal: true })` to report errors from your ErrorBoundary for accurate crash-rate tracking.

---

## Signing (iOS + Android)

`--distribution` requires real signing — the CLI does NOT embed or generate certificates.

**iOS**

- Easiest path: Xcode → target → Signing & Capabilities → "Automatically manage signing" + sign into your Apple Developer team. The CLI auto-detects the team from the resulting `.xcarchive`.
- Manual path: pass `--ios-export-options <plist>` with your own `ExportOptions.plist` (method, teamID, provisioningProfiles, signingStyle).
- Auto-generated plist (when you pass `--ios-team-id`) uses `method=app-store`, `signingStyle=automatic`, `compileBitcode=false`, `uploadSymbols=true`.

**Android**

- `signingConfigs { release { storeFile … storePassword … keyAlias … keyPassword … } }` in `android/app/build.gradle`.
- Pass sensitive values via env vars and reference `System.getenv(…)` — or use a `keystore.properties` file loaded at Gradle init.
- `--android-format aab` (default) is what Play Store wants. `apk` for sideload/internal distribution only.

---

## CI/CD

Skip the browser login with a pre-minted Deploy Token:

```bash
export SANKOFA_DEPLOY_TOKEN=sk_deploy_…
export SANKOFA_PROJECT_ID=proj_…
export SANKOFA_ENDPOINT=https://sankofa.your-company.com
export SANKOFA_ENVIRONMENT=live
```

Recommended CI flow:

```bash
# Install + build
npm ci
cd ios && bundle install && cd ..          # if using Gemfile

# Ship OTA patch only (fast path — no native build)
sankofa patch ios --publish --rollout 25 --description "$GIT_TAG" --env live

# Or a full release + submission (distribution is always built unless --skip-distribution)
sankofa release ios --publish \
  --ios-export-method app-store --ios-team-id "$APPLE_TEAM_ID"
sankofa submit ios \
  --apple-api-key-id "$APP_STORE_CONNECT_API_KEY_ID" \
  --apple-api-issuer "$APP_STORE_CONNECT_API_ISSUER"
```

On Android, pre-write `AuthKey_<ID>.p8` (for iOS) / service-account JSON (for Android) to disk from a secret store before calling `sankofa submit`.

Use `--publish` to skip confirmation prompts in non-interactive shells. `--rollout <%>` and `--mandatory` let pipelines control the rollout curve without editing the dashboard.

---

## Troubleshooting

**"You are not logged in."**  
Run `sankofa login`. If you're sure you have a token, check `echo $SANKOFA_DEPLOY_TOKEN` and `cat ~/.sankofa/credentials.json`.

**`Version mismatch: app.json says 1.2.0 but the native ios binary is built with 1.1.9`**  
The CLI reads native version first because that's what the SDK reports at runtime. Run `npx expo prebuild --platform ios` (or bump the native version manually) so they agree. `sankofa release` runs prebuild automatically on each invocation, so this error only hits when prebuild failed.

**`xcodebuild failed (log: build/xcodebuild.log)`**  
The last ~15 error lines print inline. The full log is at `build/xcodebuild.log`. Most common:
- Codegen header stale — `cd ios && pod install` (happens if `Podfile.lock` changed but the CLI's heuristic missed it — `sankofa release` now runs pod install unconditionally).
- No team configured for `--distribution` — pass `--ios-team-id` or open the workspace in Xcode once.

**`SSZipArchive` / `undefined symbol` after updating the SDK**  
A new pod dependency landed. Run `cd ios && bundle exec pod install` once. `sankofa release` does this for you on every run but if you bypassed it with `--no-native-artifact`, do it manually.

**"Downloaded v1.2.0-patch.X. Applies on next restart." repeating every launch**  
Update to the latest SDK version. If it persists, the app's reload mechanism may not be configured correctly — run `sankofa check deploy` for diagnostics.

**"Font registration was unsuccessful" after OTA**  
An asset is missing from the update bundle. Run `sankofa check deploy` and verify your assets are included in the release.

**Preview says `Up to date` but a patch exists on the dashboard**  
Check the reason shown in parentheses — common causes are version mismatch, rollout percentage, or network connectivity. Run `sankofa doctor` to diagnose.

**App can't reach the server**  
Run `sankofa doctor` to verify server reachability. For local development, ensure the simulator/emulator can reach your endpoint (use LAN IP, not `localhost`).

---

## Environment variables

| Variable | Purpose |
|---|---|
| `SANKOFA_DEPLOY_TOKEN` | CI-friendly auth; beats any on-disk token. |
| `SANKOFA_API_KEY` | Backward-compat alias; same precedence as above. |
| `SANKOFA_PROJECT_ID` | Project ID when a Deploy Token's scope isn't enough. |
| `SANKOFA_ENDPOINT` | Self-hosted server URL. |
| `SANKOFA_ENVIRONMENT` | `live` or `test`. |
| `APP_STORE_CONNECT_API_KEY_ID` | `sankofa submit ios` — API key id. |
| `APP_STORE_CONNECT_API_ISSUER` | `sankofa submit ios` — issuer UUID. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | `sankofa submit android` — path to the service-account JSON. |

---

## License

MIT.
