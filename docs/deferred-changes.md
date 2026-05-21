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

**Note on the deleted Phase 7 package:** `flutter-deploy/sankofa-flutter-deploy/flutter-sdk/` is now redundant; the Dart + Kotlin + jniLibs have all been migrated to the unified SDK. It can be deleted once we're sure no other branch / WIP work references it (audit: `grep -r "sankofa_deploy" .` should return only legacy-detection compatibility code).

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

## When iOS Flutter Code OTA ships (Phase 6)

**Current state:** `sankofa init --deploy` for Flutter only auto-patches
the Android side (AndroidManifest.xml + MainActivity.kt). iOS is untouched.

**Trigger:** Phase 6 (iOS engine port) ships.

**Files to update when this lands:**

| File | Change |
|---|---|
| `src/commands/init.ts` | Add `patchFlutterIosAppDelegate` and `patchFlutterIosInfoPlist` functions, call them from `patchFlutterNativeFiles` |
| `src/commands/doctor.ts` | Add iOS-side Flutter integration checks |
| `src/commands/flutter-push.ts` (or successor) | Remove the "iOS rejected by server" warning; the server will accept iOS flutter-code releases |
| `flutter-deploy/sankofa-flutter-deploy/docs/compliance-posture.md` | Update §5 Diff Guard checks to include Info.plist + entitlements + iOS asset diff |

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
