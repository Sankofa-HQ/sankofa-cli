# Changelog

All notable changes to `sankofa-cli`. This project uses semver (pre-1.0: minor
bumps may include breaking changes).

## 0.1.6 — Flutter flavors, iOS release, server preview

### Added
- **Flutter flavors + custom entrypoints.** `sankofa release` (iOS + Android)
  now accepts `--flavor <name>` and `-t, --target <file>`, threaded into the
  underlying Flutter build (e.g.
  `sankofa release android --flavor staging -t lib/main_staging.dart`).
  Previously a flavored app (gradle product flavors + a per-flavor
  `main_<flavor>.dart`, no `lib/main.dart`) could not be released at all —
  the build failed with "you must specify a --flavor" / "lib/main.dart not
  found". Flavored AAB discovery now also looks in
  `build/app/outputs/bundle/<flavor>Release/`.
- **`sankofa release ios` (Flutter) builds a signed `.ipa` and registers the
  release** — at parity with Android. Produces your App Store / TestFlight
  binary (or just the `.xcarchive` with `--no-codesign`) and prints the
  "uncheck Manage Version and Build Number" reminder. After it, ship code
  updates with `sankofa patch ios`.
- **`sankofa preview` works for Flutter — two modes.** *Local run* (default):
  runs your current source on a device via the Sankofa Flutter runtime (a thin
  `flutter run` wrapper), passing `--flavor`, `-t/--target`, `-d/--device`,
  build mode (`--release`/`--profile`/`--debug`), and repeatable
  `--dart-define`. *From server* (`--from-server`, or implied by
  `--label`/`--version`): downloads a published release and installs it on an
  Android device/emulator or an iOS simulator — no source needed.
- **`sankofa release --preview-artifact`** also builds + uploads an installable
  preview build (Android APK / iOS simulator app) so teammates can run a
  specific release with `sankofa preview --from-server`.
- **`sankofa patch -t, --target <file>`** picks the Flutter patch entry-point
  to compile (default `lib/sankofa_patch.dart`); `--entry-file` is an alias.
  Lets you keep several patch entries and ship one.
- **`-d, --device` short flag on `preview`** (was `--device` long-form only).

### Fixed
- **`sankofa init` no longer corrupts a project's `pubspec.yaml`.** When a project
  already had a `dependency_overrides:` block, init appended a *second* one →
  invalid YAML (`Duplicate mapping key`) that broke all Flutter tooling. It now
  **merges** the entry into the existing block (idempotent).
- **Flavored apps (no `lib/main.dart`)** — init used to silently "skip" the
  startup wiring with a misleading ✓. It now detects the real startup file
  (e.g. `lib/main_common.dart`) and prints a clear **ACTION REQUIRED** warning
  with the exact lines to add and where, since patches won't apply without it.
- **`sankofa login` now fully configures the project — no IDs/keys to type.**
  It backfills `.sankofa.json` `projectId` (previously left empty → `check`
  warned) and fills `sankofa.yaml` with BOTH `app_id` **and** `api_key`, pulled
  from the project you select at login (the server already returns the runtime
  publishable key). The deploy token is never written into the project file.
- **`sankofa init` + `sankofa login` are now order-independent.** Whichever you
  run first, the other completes the setup — no more "re-run init after login".
  `init` reuses the login-captured key to fill `sankofa.yaml`, and prints a
  clear next step when you haven't logged in yet.

### Changed
- Product picker description no longer exposes internal/implementation details.

## 0.1.5 — bundled-SDK install plumbing

### Changed
- Bundled-SDK install plumbing updated; older installs keep working via an
  automatic fallback. No behaviour change to the standard install path.

## 0.1.4 — cross-platform hosts

### Added
- **Unified Flutter patching** — `sankofa patch` ships a single signed code
  patch that applies on **both iOS and Android** from one command.
- **Windows host support** for the full Android `release` + `patch` loop —
  proven on-device. The CLI now resolves platform binaries correctly on Windows
  (`flutter.bat` / `dart.exe`), extracts archives with the bundled `tar`, and
  finds Flutter via `where`.
- **`sankofa release --dart-define <KEY=VALUE>`** — extra compile-time defines
  threaded into the Flutter build (repeatable).

### Changed / Fixed
- Cross-platform file ops throughout (`sankofa init`, RN bundling, `engine
  install --local`, `preview`): replaced Unix-only `cp -R`/`rm -rf`/`mkdir -p`/
  `ln -s`/`unzip` shellouts with Node `fs` APIs, so these commands work on
  Windows too.
- Patch builds resolve the Flutter SDK from the **project root** (not the entry
  file's dir), so `sankofa patch` finds `sankofa.yaml`'s settings.
- Engine-version detection falls back to the project's pin (`sankofa.yaml` /
  `.sankofa/flutter-version`) when `flutter --version` is unusable on a managed
  runtime. `release`/`patch` no longer need `--engine-version`.

### Host-OS support
- **Android** release + patch: macOS, Linux, **Windows** — all on-device proven.
- **iOS** release + patch: macOS (Xcode for release; patch is host-agnostic but
  proven from macOS).

## 0.1.2 and earlier
- Engine cache install from the CDN tarball, single-command engine upgrades,
  flutter-style update notices, ESM/bundler fixes. (See git history.)
</content>
