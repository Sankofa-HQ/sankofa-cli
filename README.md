# Sankofa Deploy CLI

Ship JavaScript changes to your React Native / Expo apps without cutting a new native build. Sankofa Deploy is a CodePush / Expo-Updates-style over-the-air (OTA) pipeline with a self-hostable server, a native-binary preview flow, a signed-binary build path, and direct submission to App Store Connect and Play Console.

One binary you already ship to the store. All JS/asset changes after that go through Sankofa — your users pick them up on the next app launch.

---

## Table of contents

1. [What the CLI does](#what-the-cli-does)
2. [Install](#install)
3. [Concepts](#concepts)
4. [Quickstart](#quickstart)
5. [Authentication & config](#authentication--config)
6. [Commands](#commands)
    - [`login`](#login)
    - [`logout`](#logout)
    - [`switch`](#switch)
    - [`status`](#status)
    - [`release`](#release)
    - [`patch`](#patch)
    - [`preview`](#preview)
    - [`dist`](#dist)
    - [`submit`](#submit)
7. [The release pipeline in detail](#the-release-pipeline-in-detail)
8. [Asset handling (fonts, images, videos…)](#asset-handling-fonts-images-videos)
9. [Rollout, rollback, and crash reporting](#rollout-rollback-and-crash-reporting)
10. [Signing (iOS + Android)](#signing-ios--android)
11. [CI/CD](#cicd)
12. [Troubleshooting](#troubleshooting)
13. [Environment variables](#environment-variables)

---

## What the CLI does

| Command | Purpose |
|---|---|
| `sankofa login` | Browser-based auth; creates a Deploy Token for the selected project and persists a session JWT for later `switch`es. |
| `sankofa logout` | Remove stored credentials (project-scoped, global, or both). |
| `sankofa switch` | Switch to a different project on the same server. Reuses the stored JWT — no browser round-trip. |
| `sankofa status` | List releases + rollouts + install/rollback counts for the current project. |
| `sankofa release` | Build the native artifact, stage a byte-identical OTA archive (bundle + assets) from it, publish a base release, **and** produce a signed store binary (`.ipa` / `.aab`) ready for `sankofa submit`. |
| `sankofa patch` | Ship a JS+assets-only OTA patch against an existing base release. |
| `sankofa preview` | Download + install + launch a published release or patch on a simulator/emulator. Streams runtime logs to the terminal by default. |
| `sankofa dist` | Build ONLY the signed store binary. No Sankofa release is published. For rebuilding the binary of an existing release or for OTA-only lanes. |
| `sankofa submit` | Upload the signed distribution binary to App Store Connect (iOS) or Play Console (Android). |

Every command that hits the server short-circuits with a clean "you are not logged in" message when credentials are missing — no stray prompts before the auth check.

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

- **Base release** — an OTA archive tied to a specific `target_binary_version` (e.g. `1.2.0`). Ships with the embedded native binary's first build for that version. Label is `v<version>`.
- **Patch release** — a JS + assets archive that updates a base. Label is `<base-label>-patch.<n>` (e.g. `v1.2.0-patch.3`). Inherits the base's native binary metadata.
- **OTA archive (`ota.zip`)** — `bundle.jsbundle` + `assets/`. Unzipped on-device into `Library/Application Support/SankofaDeploy/<label>_<hash>/`. RN's `AssetSourceResolver` resolves `assets/...` relative to the bundle URL's directory, so every font/image the JS references is found.
- **Native preview artifact** — iOS `.app.zip` (simulator) or Android `.apk`. Used only by `sankofa preview` to reproduce what real users see. NOT submittable to a store.
- **Distribution binary** — iOS `.ipa` (App Store / TestFlight) or Android `.aab` / `.apk` (Play Store). Built only with `--distribution`. This is what `sankofa submit` uploads.
- **Rollout** — percentage of unique devices that receive a given release, bucketed deterministically by a sha256 of `(distinctId, releaseId)`.
- **Mandatory update** — forces the app to download-and-apply immediately instead of staging for next launch.

---

## Quickstart

```bash
# 1. Auth (browser flow).
sankofa login

# 2. Ship the first release. Every `release` builds the OTA archive AND the
#    signed store binary — you always have something submittable. Append
#    --skip-distribution only on OTA-only CI lanes.
sankofa release ios
sankofa submit ios --apple-api-key-id ABC --apple-api-issuer UUID

# 3. After the store build is out, ship a JS/assets-only patch:
sankofa patch ios

# 4. Need to rebuild JUST the signed binary for the current version
#    (e.g. signing certs refreshed, release already exists):
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

Every `release` produces, in this order, **three things you can see and verify**:
1. A **preview native artifact** (`.app.zip` / `.apk`) consumed by `sankofa preview`.
2. An **OTA archive** (`ota.<platform>.zip`) uploaded to the Sankofa server.
3. A **signed store binary** (`.ipa` / `.aab`) ready for App Store Connect or Play Console — unless you pass `--skip-distribution`.

There's no `--distribution` flag; distribution is always on. If you genuinely only want OTA (e.g. a CI lane that ships the binary via a separate process), pass `--skip-distribution`.

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

For **patches**, the CLI extracts the OTA archive locally, copies `bundle.jsbundle` + `assets/` into the simulator's data container at `Library/Application Support/SankofaDeployPreview/<label>/`, and seeds the SDK's `sankofa_deploy_bundle_path` so the app loads exactly that bundle on startup.

For **base releases**, only the label is seeded (the embedded bundle provides the JS). This prevents the SDK from re-downloading the very release you just previewed.

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

## The release pipeline in detail

Every `sankofa release <platform>` runs the following, in order:

1. **Auth check** — short-circuits before any prompt if credentials are missing.
2. **Resolve project root** — walks up from `cwd`, or uses `--project`. Prompts among candidates in a monorepo.
3. **Sync native from `app.json`** — `npx expo prebuild --platform <platform> --no-install --non-interactive`. Keeps `CFBundleShortVersionString` / `versionName` in lock-step with `app.json`'s version.
4. **Detect version** — reads Info.plist or build.gradle first (that's what the SDK reads at runtime). If `app.json` disagrees, throws immediately with the `expo prebuild` instruction — never publishes a cross-version release.
5. **Duplicate-version check** — if there's already a base release for this version + platform, the CLI suggests `sankofa patch` instead and exits.
6. **Clear build caches** — `./build` gets wiped. Native caches (`ios/build`, `android/.gradle`) are deliberately kept for incremental rebuilds.
7. **Pod install** (iOS) — always runs. A no-op when `Podfile.lock` matches `Pods/Manifest.lock`, so podspec changes from a linked SDK never slip through silently.
8. **Native build**:
    - iOS: `xcodebuild -configuration Release -sdk iphonesimulator -derivedDataPath …`. Full stderr is captured to `build/xcodebuild.log`; on failure, the relevant error lines are surfaced inline.
    - Android: `./gradlew assembleRelease`.
9. **Stage OTA from the native artifact** — extracts `bundle.jsbundle` + `assets/` directly out of the `.app` / `.apk`. This is what guarantees byte-identical asset IDs between the embedded bundle and the uploaded archive: Metro isn't deterministic across runs, so we never call Metro twice for the same release.
10. **`zip -r ota.<platform>.zip .`** inside the stage dir. Flat layout, absolute archive path.
11. **SHA256** of the archive bytes.
12. **Upload** — POSTs `bundle=ota.zip` + `bundle_format=zip` + the native preview artifact + metadata to `POST /api/v1/deploy/releases`.
13. **Distribution build** — `xcodebuild archive` → `xcodebuild -exportArchive` with an `ExportOptions.plist` (iOS), or `./gradlew bundleRelease` (Android). Runs on every `release` unless `--skip-distribution` is passed. A failure here is non-fatal — the OTA release is already published; the CLI prints `sankofa dist <platform>` to retry the signed-binary step once signing is fixed.
14. **Summary** — OTA + preview + distribution artifact paths, sizes, and SHA256s are printed in bold with highlighted hashes.

`sankofa patch` is the same pipeline minus steps 8–10 (no native build), plus Metro with `--assets-dest` to emit `bundle.jsbundle` + `assets/` manually, which then get zipped.

---

## Asset handling (fonts, images, videos…)

Sankofa Deploy ships assets inside the OTA archive — this is what makes `useFonts`, `require('./image.png')`, and any other asset reference survive a patch.

- CLI emits `assets/` alongside `bundle.jsbundle` via Metro's `--assets-dest` flag, or copies the directory out of the native artifact (for base releases).
- SDK unzips the archive into `Library/Application Support/SankofaDeploy/<label>_<hash>/` (iOS) or `filesDir/SankofaDeploy/<label>_<hash>/` (Android).
- AppDelegate / ReactHost reads `sankofa_deploy_bundle_path` and hands RN a `file://…/bundle.jsbundle` URL.
- RN's `AssetSourceResolver` resolves every `assets/…` path relative to the bundle URL's directory — so the fonts/images next to `bundle.jsbundle` are found. No custom native resolver needed.

Asset drift cause-of-death (byte-different Metro output) is avoided for base releases by copying from the freshly-built `.app` and avoided for patches by shipping the assets alongside the bundle. A patch bundle can't reference an asset that wasn't also in its archive.

---

## Rollout, rollback, and crash reporting

- **Rollout %** is deterministic per device (`sha256(distinctId + releaseId) mod 100 < percent`). Increasing a rollout only adds new devices; the sampled set is stable.
- **Mandatory** updates call `downloadAndApply` immediately after `checkForUpdate`. Optional updates call `downloadInBackground` (applied on next restart).
- **Auto-rollback**: if the native binary boots twice within 30 seconds without calling `deploy.notifyAppReady()`, the SDK reverts to the previous bundle, fires a `rollback` event, and sets `rolled_back_label` so the same bad label won't be re-downloaded. A 10-second auto-confirm timer is the safety net.
- **Global JS error handler**: the SDK installs `ErrorUtils.setGlobalHandler` so uncaught fatal errors in an OTA bundle immediately roll back, fire `crash_on_update`, and reload. Embedded-bundle crashes don't fire a rollback (there's nothing to roll back to) but still report the crash.
- **Debounce**: repeated fatal errors in the same session only fire one `rollback` event. No inflated counters from Retry-button spam.
- **Dashboard** surfaces `total_installs`, `total_rollbacks`, `total_crashes`, `unique_devices` per release.

Exposed as `SankofaDeploy.reportError(err, { fatal })` for apps to forward ErrorBoundary catches (Expo Router's boundary is wrapped in the bundled example).

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
The bridge didn't reload. Fixed in SDK ≥ current version — the SDK now posts `RCTTriggerReloadCommandNotification` (not the deprecated `RCTBridgeWillReloadNotification`). Also, `downloadInBackground` no-ops when the same label is already pending, so even a bad reload can't loop.

**"Font registration was unsuccessful" after OTA**  
An asset reference drifted. Base releases avoid this by extracting bundle + assets from the signed native artifact. Patches ship assets via `--assets-dest`. If you still hit it, the OTA archive is missing the asset — inspect with `unzip -l build/ota.<platform>.zip`.

**Preview says `Up to date` but a patch exists on the dashboard**  
Watch the reason in parens: `no_matching_release` (wrong version), `not_in_rollout` (device's distinctId hash is above the rollout %), `missing_update_context` (empty version sent), `check_network_error:…` (simulator can't reach the endpoint). If it's a network error, check `SANKOFA_ENDPOINT` vs what the app hits — simulator can reach LAN IPs via `NSAllowsLocalNetworking`.

**Preview says `Update check failed: check_network_error:…`**  
The app couldn't reach the Sankofa server. `curl <your endpoint>/healthz` from your host to confirm the server is listening on the right address; if yes, the simulator's network is the suspect.

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
