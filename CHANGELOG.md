# Changelog

All notable changes to `sankofa-cli`. This project uses semver (pre-1.0: minor
bumps may include breaking changes).

## 0.1.4 — unreleased (cross-platform hosts + unified KBC)

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
