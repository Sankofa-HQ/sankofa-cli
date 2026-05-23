# Deferred Changes — sankofa CLI

Pragmatic shortcuts we took during Phase 10 that will need to be revisited
once a specific external event happens. Each entry is keyed by the trigger
that unlocks the change.

---

## When `sankofa_flutter` is published to pub.dev

**Current state:** the unified Flutter SDK lives at
`sdks/sankofa_sdk_flutter/` (directory) with package name
`sankofa_flutter` (per pubspec). Phase 7's standalone `sankofa_deploy`
has been folded into it under `lib/src/deploy/`. The CLI and
`hello_sankofa` reference it via path dependency:

```yaml
sankofa_flutter:
  path: ../../../sdks/sankofa_sdk_flutter
```

**Future state:** publish to pub.dev so customers install with
`flutter pub add sankofa_flutter` — no path dependency needed.

**Files to update when this lands:**

| File | Change |
|---|---|
| `cli/sankofa-cli/src/commands/init.ts` | `installDeployFlutter` already prints `flutter pub add sankofa_flutter` — once pub.dev publishes, this is the actual command (no path dep needed) |
| `flutter-deploy/sankofa-flutter-deploy/hello_sankofa/pubspec.yaml` | Replace `sankofa_flutter: path: ../../../sdks/sankofa_sdk_flutter` with `sankofa_flutter: ^x.y.z` |
| `sdks/sankofa_sdk_flutter/pubspec.yaml` | Bump version + remove `publish_to: none` (or set it to a private registry URL if going private-by-default) |

**Trigger:** API stable + ready for external customer install.

**Note on the deleted Phase 7 package:** `flutter-deploy/sankofa-flutter-deploy/flutter-sdk/` was DELETED on 2026-05-21 after a full migration + audit confirmed zero live code references. Git history preserves the work. The CLI's `init.ts` and `products.ts` still accept the legacy `sankofa_deploy` pubspec entry as backward-compat detection (for any branch still mid-migration), but no path / package on disk references it.

---

## When the server's reverse-handshake schema lands "module integration status"

**Current state:** the Flutter `SankofaDeploy` runs a self-audit on init
([`checkIntegration()`](../../../sdks/sankofa_sdk_flutter/lib/src/deploy/sankofa_deploy.dart))
that inspects the host's AndroidManifest, MainActivity class hierarchy,
INTERNET permission, `com.sankofa.apiKey`/`endpoint` meta-data, and JNI
initialization. The result is cached in
`Sankofa.instance.lastDeployIntegrationStatus` and printed as a debug
warning when the integration is partial/broken. **It is not yet
forwarded to the server.**

The Flutter `Sankofa.init` currently does NOT send a reverse handshake
(unlike RN, which sends `?installed=core,deploy,catch&platform=android`
to `/api/v1/handshake`). The Flutter side fetches its own deploy state
through the platform plugin's HTTP call inside the Updater.

**Target state:**

1. Flutter `Sankofa.init` issues a reverse handshake on startup that
   includes both the installed module list AND each module's
   integration status, e.g.:
   ```
   GET /api/v1/handshake?installed=core,deploy
       &integration=deploy:partial:no_sankofa_application,no_internet_permission
   ```
2. Server records the integration status per device/release/distinct_id.
3. Dashboard surfaces "SDK Integration Incomplete" badge for any
   project whose latest reverse handshake reports a non-`full` module.

**Trigger:** when we have time + the dashboard surface to display it.
Without the dashboard side this is invisible to the developer except
via debug-mode logs.

**Files to update when this lands:**

| File | Change |
|---|---|
| `sdks/sankofa_sdk_flutter/lib/src/sankofa_client.dart` | Add reverse handshake call in `init()` after Deploy audit; encode the audit result via `integration=` query param |
| `sdks/sankofa_sdk_react_native/src/index.ts` | Already sends `installed=`; needs to also encode the cached `Sankofa.lastDeployIntegrationStatus` as `integration=deploy:partial:...` on the reverse handshake. |
| ~~`sdks/sankofa_sdk_react_native/src/deploy/SankofaDeploy.ts`~~ | ✅ DONE 2026-05-21 — `checkIntegration()` mirrors Flutter shape. Probes `SankofaDeployBundleProvider` wired-flag + INTERNET permission (Android) + storage round-trip + AppDelegate class name (iOS). Auto-runs in `Sankofa.initialize` 1.5s after init; prints warnings only in `__DEV__`. Result cached on `Sankofa.lastDeployIntegrationStatus`. |
| `server/engine/ee/deploy/handshake.go` | Parse the new `integration` query param into the `DeviceContext`; persist to a new column on the device-attribution table |
| `dashboard/ee/components/deploy/` | New widget: "SDK Integration Incomplete" with per-module breakdown |

---

## When the legacy `--android-format` flag is removed

**Current state:** `sankofa release` accepts both new `--apk`/`--appbundle`
boolean flags AND the legacy `--android-format <fmt>` flag. The new flags
take precedence when both are passed.

**Trigger:** one CLI release cycle has elapsed and no internal scripts
reference `--android-format`.

**Files to update:**

- `src/commands/release.ts` — remove the `.option('--android-format ...')`
  line and the `opts.androidFormat = 'apk'|'aab'` normalization block.
  The downstream `androidFormat: opts.androidFormat === 'apk' ? 'apk' : 'aab'`
  in `buildDistributionArtifact()` call can switch to reading
  `opts.apk ? 'apk' : 'aab'` directly.

---

## ~~When iOS Flutter Code OTA ships (Phase 6)~~ — ✅ DONE 2026-05-23

Most of this entry has shipped. Tracking remaining items below.

**What landed:**

| ✅ | File | Change |
|---|---|---|
| ✅ | `src/commands/init.ts` | `patchFlutterIosAppDelegate` + `patchFlutterIosInfoPlist` (commit `f3a9408` on `phase6/ios-codepush`, merged to main) |
| ✅ | `src/utils/products.ts` | `detectDeployFlutter` now probes `AppDelegate.swift` alongside `AndroidManifest.xml` |
| ✅ | Engine fork | iOS engine binaries built + registered with `+sankofa-1` marker (commits `a36966df3ec` workflow registration step, `3661aa1c87b` marker patch) |
| ✅ | Engine fork | iOS AOT override hook on `FlutterDartProject` (commit `8c331063655` on `phase5/ios-aot-override` — Phase 5 iOS) |
| ✅ | `sankofa_sdk_flutter` iOS | `SankofaFlutterAppDelegate` + `SankofaUpdaterBridge` + vendored `SankofaUpdaterFFI.xcframework` |
| ✅ | `sankofa-flutter-deploy` | `updater/build-ios.sh` + Rust iOS targets + xcframework packaging + CI workflow |

**Still pending:**

| File | Change |
|---|---|
| `src/commands/flutter-push.ts` (or successor) | Remove the "iOS rejected by server" warning; server-side `flutter-push` handler still has it. Server work is independent — flip the rejection to acceptance once an iOS Flutter-code release format is finalised. |
| `flutter-deploy/sankofa-flutter-deploy/docs/compliance-posture.md` | Update §5 Diff Guard checks to include `Info.plist` + entitlements + iOS asset diff. The CLI's `baseline.ts` / `diffGuard.ts` already handle generic asset diffs; iOS-specific thresholds (Info.plist key changes, entitlement edits) need their own rules. |
| `sankofa_sdk_flutter` iOS | Replace `respondsToSelector:` dynamic dispatch in `SankofaFlutterAppDelegate` with a direct `FlutterDartProject.sankofaSet…` call once the engine-fork patch reaches every customer's Flutter.framework. Defensive fallback is conservative for now; remove when the Sankofa-built Flutter.framework is the default consumer install. |

---

## When `flutter create` shapes diverge from canonical

**Current state:** the Dart-side patcher (`patchFlutterMainDart` in
`init.ts`) uses regex matching against the canonical `flutter create`
output. Works for `void main() => runApp(...)` and `void main() { runApp(...); }`
shapes.

**Trigger:** customer reports that `sankofa init --deploy` failed to wire
their `lib/main.dart` because they had a custom `main()` shape (async,
multiple `runApp` calls, conditional bootstrap, `WidgetsFlutterBinding`
already initialized in a different place).

**Files to update when this lands:**

- `src/commands/init.ts` — replace regex-based `patchFlutterMainDart` with
  a proper Dart AST walker. Consider using
  [`analyzer`](https://pub.dev/packages/analyzer) via a small Dart helper
  binary, or a TypeScript port of the Dart grammar. Until then, the
  patcher will detect "non-canonical shape" and print manual snippet for
  the dev to apply.

---

## When the CLI is published to npm

**Current state:** `package.json` `"description"` still reads
"Sankofa Deploy CLI — push OTA updates to your React Native apps."
That's accurate for v0.1, but no longer accurate after Phase 10 — the
CLI now drives Deploy (RN + Flutter), Switch, Config, and Catch across
five stacks.

**Trigger:** first `npm publish`.

**Files to update when this lands:**

- `package.json` `"description"` — "Sankofa CLI — manage Deploy, Switch, Config, and Catch across React Native, Flutter, Web, iOS, and Android projects."
- `package.json` `"keywords"` — add `flutter`, `feature-flags`, `error-tracking`, `analytics`
- `README.md` — full rewrite for the multi-product, multi-stack surface
- Confirm version bump from `0.1.0` → `1.0.0-rc.1` or similar

---

## When non-Deploy Flutter products ship distinct SDK signals

**Current state:** `detectInstalledProducts()` in `src/utils/products.ts`
checks `sankofa_deploy` presence in `pubspec.yaml` for Switch / Config /
Catch on Flutter too — because today there's no separate signal. So a
Flutter project that has Deploy installed will report Switch / Config /
Catch as "installed" even if those product APIs are never used.

**Trigger:** the unified `sankofa_sdk_flutter` exposes per-product subpaths
(e.g. `sankofa_sdk_flutter/switch.dart`, `sankofa_sdk_flutter/catch.dart`)
that `init` can detect independently, OR each product ships as its own
pub.dev package.

**Files to update when this lands:**

- `src/utils/products.ts` — extend `detectProduct()` with per-product
  Flutter detectors that look for the right import or initializer
  signature. Today's logic conflates SDK presence with product-API usage.

---

## When the customer's Flutter binary subprocess can run reliably

**Current state:** `sankofa doctor`'s `flutter --version` check sometimes
reports "flutter not on PATH" when the binary IS on PATH but the
subprocess is killed (low-memory machines: `shared.sh: Killed: 9`). The
catch branch can't distinguish ENOENT from a signal kill.

**Trigger:** customer reports the misleading error message on a healthy
machine.

**Files to update when this lands:**

- `src/commands/doctor.ts` — in the `Flutter SDK` check, inspect the
  error's `status` / `signal` / `code` fields rather than catching all
  errors as "not on PATH". Surface "subprocess killed" / "subprocess
  timed out" as their own warn states with actionable advice (raise
  memory, close other apps).

---

## When the build no longer needs 8GB heap

**Current state:** `npm run build` invokes tsc with `--max-old-space-size=8192`
because the default Node heap OOM-kills the type checker. Root cause is
likely the inquirer + googleapis + types/node combo blowing up the type
inference graph.

**Trigger:** dependency cleanup or TS version bump lets tsc finish under
the default 4GB heap.

**File to update:** `package.json` — change `"build"` back to plain `"tsc"`.

**Investigation pointers for future-me:** run
`tsc --extendedDiagnostics` to see where memory goes; check whether
`@types/inquirer` v9 is the culprit (it pulls a lot of recursive types);
consider switching to `inquirer/promises` or `@inquirer/prompts` which
ship leaner types.
