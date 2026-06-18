# Changelog

All notable changes to `sankofa-cli`. This project uses semver (pre-1.0: minor
bumps may include breaking changes).

## 0.1.6 — Flutter init/login onboarding fixes

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

## 0.1.5 — release-branch rename

### Changed
- Bundled-SDK install now clones `release/sankofa-<version>` (renamed from the
  legacy `phase1/sankofa-<…>` scheme). The legacy branch is kept on the remote
  for one cycle and used as an automatic clone fallback, so older installs and
  transitional states keep working. No behaviour change to the primary CDN
  tarball install path.

## 0.1.4 — cross-platform hosts + unified KBC

### Added
- **Unified Flutter KBC patching** — `sankofa patch` ships a signed `.skdp`
  bytecode envelope for **both iOS and Android** (the engine interpreter runs it
  on either platform). Android no longer takes the legacy `libapp.so` path.
- **Windows host support** for the full Android `release` + `patch` loop —
  proven on-device. The CLI now resolves platform binaries correctly on Windows
  (`flutter.bat` / `dart.exe` / `dartaotruntime.exe`), extracts archives with the
  bundled `tar`, and finds Flutter via `where`.
- **`sankofa release --dart-define <KEY=VALUE>`** — threaded into the Flutter AOT
  build (repeatable). Used e.g. for engine-check bypass on unstamped forks.

### Changed / Fixed
- Cross-platform file ops throughout (`sankofa init`, RN bundling, `engine
  install --local`, `preview`): replaced Unix-only `cp -R`/`rm -rf`/`mkdir -p`/
  `ln -s`/`unzip` shellouts with Node `fs` APIs (`cpSync`/`rmSync`/`mkdirSync`/
  `symlinkSync` + `tar`-on-Windows), so these commands work on Windows too.
- KBC patch builds resolve the Flutter dart-sdk from the **project root** (not
  the entry file's dir), so `sankofa patch` finds `sankofa.yaml`'s engine pin.
- Engine-version detection falls back to the project's authoritative pin
  (`sankofa.yaml` / `.sankofa/flutter-version`) when `flutter --version` is
  unusable (`0.0.0-unknown` on a fork clone whose `git describe` is hijacked by
  the `v…+sankofa-N` tag). `release`/`patch` no longer need `--engine-version`.

### Host-OS support
- **Android** release + patch: macOS, Linux, **Windows** — all on-device proven.
- **iOS** release: macOS only (Xcode). iOS KBC patch is host-agnostic in
  principle (no Xcode) but proven from macOS only.

## 0.1.2 and earlier
- Engine cache install from the CDN tarball, single-command engine upgrades,
  flutter-style update notices, ESM/bundler fixes. (See git history.)
</content>
