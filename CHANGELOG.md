# Changelog

All notable changes to `sankofa-cli`. This project uses semver (pre-1.0: minor
bumps may include breaking changes).

## 0.1.16 — Patch apps with relative imports (flavored entrypoints)

### Fixed
- **`sankofa patch` failed on any file that used a relative import.** The
  generated patch unit copied the source file's imports verbatim, including
  relative ones like `import 'main.dart'`. A relative import can't resolve from
  the unit's temporary build location, so the patch failed to compile. This bit
  **flavored apps hardest**: a per-flavor entrypoint such as
  `lib/main_production.dart` almost always imports shared code relatively. The
  extractor now rewrites a file's relative imports to `package:` URIs (resolved
  against the file's own package URI), so they resolve through `--import-dill`,
  while `dart:`/`package:` imports are still copied verbatim. Found by testing a
  real two-flavor app end-to-end.
- **`sankofa keys generate` now wires the public key into `sankofa.yaml`.** The
  SDK reads `signing_pubkey` from the bundled yaml to verify every patch, but
  nothing wrote it there — you had to paste it by hand or the SDK couldn't
  verify. `keys generate` now stamps `signing_pubkey` into `sankofa.yaml`
  (updating in place on rotation); the printed `Sankofa.initialize(
  deploySigningPubkey: …)` snippet remains an equivalent alternative.

## 0.1.15 — Android: unblock fresh installs (Built-in Kotlin pin)

### Fixed
- **A fresh `pub get` broke the Android build.** `shared_preferences_android`
  2.4.24+ migrated to Flutter's Built-in Kotlin: its `android/build.gradle.kts`
  declares only `com.android.library` and then calls
  `kotlin { compilerOptions { … } }`, expecting the Flutter Gradle plugin to
  apply KGP on its behalf. The engine's Flutter 3.44.1 tooling doesn't apply it
  in time for that script's compilation, so a NEW project failed with
  `Unresolved reference: compilerOptions / jvmTarget`. Existing machines were
  immune only because their pub-cache still held 2.4.23, which applies
  `kotlin-android` itself — so this hit new users exclusively.
  `sankofa init` now pins `shared_preferences_android: 2.4.23` in
  `dependency_overrides` (merged into any existing block, never a duplicate
  key), with inline notes on why and when to remove it. This is upstream drift,
  not a Sankofa divergence — our Android template is upstream 3.44.1's,
  untouched, so stock Flutter 3.44.1 fails identically. Drop the pin once the
  engine tracks a newer stable.

## 0.1.14 — Flutter engine-bundle robustness + fresh-machine patching

### Added
- **`sankofa patch` now works on any machine** — the changed-function extractor
  is compiled on first use with the bundled engine's own `dart compile
  aot-snapshot` (analyzer resolved from the bundle's flutter_tools
  package_config), so the snapshot is version-coherent with `dartaotruntime` by
  construction. One-time ~10s per engine version, cached inside the bundle,
  keyed on the extractor-source hash so a CLI upgrade can never reuse a stale
  snapshot. Previously the CLI-shipped snapshot only ran when its Dart snapshot
  format happened to match the customer's engine — otherwise patching required
  an internal dev checkout.
- **Patches can use the app's own types.** The generated patch unit now
  self-imports each source file by its `package:` URI, so a lifted method body
  can reference the classes and top-level functions its own library declares
  (previously: `Error: Type 'Summary' not found` — only core/Flutter types
  worked).
- **`sankofa init` scaffolds `sankofa_dynamic_interface.yaml`** (the app's
  patchable surface) and **stamps `engine_version` into `sankofa.yaml`**;
  every Flutter build path stamps it too before assets are packed. Builds now
  actually pass `--dynamic-interface`, and the SDK can report engine identity
  at runtime.
- **Patchable-seam diagnostic.** A changed method that uses `this` or calls a
  sibling method now fails `sankofa patch` with an error naming the method and
  the offending construct — instead of a CFE error pointing at a generated
  temp file the customer never wrote.

### Fixed
- **`--dry-run` honors `--release <label>`** — it resolves that release's local
  auto-diff base instead of whichever release last wrote the top-level
  baseline manifest.
- **Stale bundle after an engine roll**: on a cache hit the bundler now compares
  the cached bundle's `bin/internal/engine.version` against the manifest's
  `engine_rev` and re-fetches on drift (fail-open — a network blip keeps the
  cache; the release engine-identity guard is the backstop). Previously a bundle
  cached by label was reused even after the label pointed at a new engine.
- **Tarball bundles that ship no `.git`**: `flutter` refuses to run (and never
  bootstraps its dart-sdk) unless `FLUTTER_ROOT` is a git repo with a tracked
  `bin/internal/engine.version`. The tarball installer now reconstructs a minimal
  git repo (commit that tracks `engine.version` + a version tag) so the bundle is
  always runnable — otherwise `base_noaot.dill` never captures and real-code
  `sankofa patch` silently can't work.
- **`sankofa patch` in a non-interactive shell** with multiple baselines and no
  `--release`: now errors with an actionable message instead of crashing with a
  raw `ERR_USE_AFTER_CLOSE: readline was closed`.
- **Silent base-kernel capture failure**: `sankofa release` no longer swallows a
  failed `base_noaot.dill` capture — it prints a loud warning explaining the
  release shipped without it and that real-code patches will refuse until a
  re-release.

## 0.1.13 — docs: stop publishing credential-storage internals

### Changed
- The public README no longer documents on-disk credential paths, the credential
  JSON schema, session/JWT auth mechanics, or the patch-signing private-key path.
  Auth docs are now task-oriented (`sankofa login` + Deploy Token for CI). Keeps
  the "safe to commit vs protect" guidance.
- Stopped shipping a stray `.bak` in the published tarball (`*.bak` ignored).

## 0.1.12 — Flutter auto-diff code-push

### Added
- Flutter auto-diff `sankofa patch`: edit real Dart, ship only changed functions.
- Base built with `--dynamic-interface` so patches resolve `dart:core` members.
- Default engine `3.44.1+sankofa-2`, honoring the project's `sankofa.yaml` pin.

## 0.1.11 — clean, customer-facing output (no implementation jargon)

### Changed
- **Plain-English everywhere the CLI talks to you.** The platform picker, build
  spinners, publish summaries, help text, and error messages no longer expose
  build-internal jargon. The `release`/`patch`/`preview` flows now read as a
  product ("Building patch…", "Android", "iOS", "Registering iOS baseline…")
  instead of leaking how the pipeline is implemented under the hood. No
  behaviour change — same commands, same flags, same output structure.

- **Advanced command renamed** `sankofa kbc …` → `sankofa patch-tools …` (still
  hidden; same `build` / `wrap` / `inspect` subcommands and flags). Update any
  CI script that called the old name. Most users use `sankofa patch` and are
  unaffected.

### Fixed
- **Honest message for `preview --from-server` on iOS.** It previously failed
  with "no installable preview artifact" and told you to re-publish with
  `release ios --preview-artifact` — a flag that's intentionally a no-op on iOS,
  so following it did nothing. iOS now explains the real situation (a physical
  iPhone can't install a downloaded build, so there's no server-side iOS preview
  artifact) and points to `sankofa preview ios` for local QA and TestFlight for
  on-device testing. Android is unchanged.

### Packaging
- **Published package is now source-clean.** The build strips comments and no
  longer ships `.d.ts` type declarations or `.js.map` source maps (neither is
  used by a CLI binary). The shipped JavaScript carries no internal
  implementation identifiers or filenames. The npm tarball is smaller and
  contains only the executable JavaScript.

## 0.1.10 — `release ios`: single build, fail-fast auth, no presign trap

### Fixed
- **No more double build.** `sankofa release ios --preview-artifact` used to run a
  *second* full build (an iOS simulator app, several minutes) on top of the
  `.ipa`. That's gone — iOS `release` is now single-build like a normal store
  release. `--preview-artifact` is a no-op on iOS (the sim artifact is
  simulator-only and low-value when you test on device); for local QA use
  `sankofa preview ios …`.
- **Fail fast on auth / duplicate baseline.** `release ios` now validates the
  Deploy Token + checks for an existing baseline **before** the build, so a bad
  token or a duplicate version fails in ~2 seconds instead of after a multi-
  minute build.
- **Deploy Token no longer trips on presign.** Uploading a native/preview
  artifact first calls a presign endpoint; if that endpoint rejects the Deploy
  Token (401/403 — it's gated for dashboard JWTs on some servers), the CLI now
  **falls back to the inline upload** (which accepts Deploy Tokens) instead of
  aborting the whole release with a misleading "Invalid token". This is what
  caused `release ios --preview-artifact` to fail at the very end with
  "Unauthorized: Invalid token" despite a valid token.

## 0.1.9 — cleaner, correct `.gitignore` from `init`

### Fixed
- **`sankofa init` now writes one tidy `.gitignore` block.** Previously it
  emitted (a) a redundant pile of `build/*` lines all already covered by
  `build/`, and (b) a *separate*, stray `.sankofa/` rule outside the managed
  block that ignored the **whole** `.sankofa/` dir — including the vendored
  `dynamic_modules/` that your `pubspec.yaml` path-override needs, so fresh
  clones and CI broke on `flutter pub get`.
- Now it ignores only what's truly disposable — `.sankofa.json`, `build/`, and
  the transient `.sankofa/build/` + `.sankofa/baseline/` — and **commits**
  `.sankofa/dynamic_modules/` + `.sankofa/flutter-version`, so a fresh clone /
  CI builds without re-running `init`. All in a single consolidated block.

## 0.1.8 — `preview` targets the right device automatically

### Fixed
- **`sankofa preview ios` / `preview android` now auto-select a connected
  device of that platform.** Previously the platform argument was ignored and
  the CLI ran a bare `flutter run` with no device — so on a machine with a
  Mac/Chrome device also present, Flutter tried to satisfy **web/desktop**
  artifacts too and failed fetching the web SDK (a 404 that aborted the whole
  run). You no longer need `flutter config --no-enable-web` or any web
  workaround: `preview ios` builds for iOS only, `preview android` for Android
  only. Pass `-d <id>` to override; pass neither platform nor device and it
  falls back to Flutter's default selection.

## 0.1.7 — correct `--version` reporting

### Fixed
- **`sankofa --version` reported a stale, hardcoded version** (`0.1.4`) no matter
  what was actually installed, and the update notice told current users to
  "upgrade". The version is now read from the package's own `package.json` at
  runtime — single source of truth, so it can never drift again. (0.1.6's
  features were genuinely installed; only the reported version string was wrong.)

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
