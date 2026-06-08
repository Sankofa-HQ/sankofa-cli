# Sankofa Flutter — fresh customer e2e walkthrough

A clean-room test that simulates what a real customer experiences after
0.2.0 of the CLI hits npm and 0.2.1 of the SDK is live on pub.dev.

Run each block in order. **Expected:** lines are what you should see —
if anything diverges, stop and investigate before continuing.

---

## Step 0 — Publish the CLI (one-time per release)

```sh
# In /Users/saytoonz/Developer/Projects/Sankofa/cli/sankofa-cli
npm whoami                                  # → must be a Sankofa-HQ owner
cat package.json | jq -r .version           # → 0.2.0
npm publish --dry-run | tail -10            # sanity-check the tarball
npm publish                                 # ← the real publish
```

**Expected:** `+ sankofa-cli@0.2.0`. Then `npm view sankofa-cli version`
should print `0.2.0` within a few seconds.

---

## Step 1 — Wipe every local Sankofa breadcrumb

We want this run to resolve everything from the official registries
(pub.dev, npm, download.sankofa.dev, api.sankofa.dev) — not from
caches the local machine has accumulated during development.

```sh
# 1a — uninstall the global CLI (currently a symlink to /Users/saytoonz/...)
npm uninstall -g sankofa-cli
which sankofa || echo "(good — no sankofa on PATH)"

# 1b — drop the pub cache for sankofa_flutter
ls ~/.pub-cache/hosted/pub.dev/ | grep ^sankofa_flutter
rm -rf ~/.pub-cache/hosted/pub.dev/sankofa_flutter-*

# 1c — drop the CLI's bundled-Flutter + engine + auth caches
rm -rf ~/.sankofa
ls ~/.sankofa 2>&1 | head -1                # → No such file or directory

# 1d — make sure pub doesn't re-resolve from a project lockfile pointing at the dev tree
#       (only matters if you've run the SDK example app against a path: dep recently)
find ~/Developer/Projects -name pubspec.lock -path '*/example/*' 2>/dev/null | head
```

**Expected after 1a–1c:** `which sankofa` empty, `~/.sankofa` gone,
`~/.pub-cache/hosted/pub.dev/sankofa_flutter-*` gone.

---

## Step 2 — Re-install from official npm

```sh
npm install -g sankofa-cli@0.2.0
sankofa --version                           # → 0.2.0
which sankofa                               # → /usr/local/bin/sankofa (a npm install dir, not your dev tree)
readlink "$(which sankofa)"                 # → ../lib/node_modules/sankofa-cli/dist/index.js
```

**Expected:** `0.2.0`, and `readlink` points inside `lib/node_modules/sankofa-cli/`
(NOT into `Developer/Projects/Sankofa/cli/sankofa-cli/dist/`).

---

## Step 3 — Authenticate against api.sankofa.dev

```sh
sankofa login
# → opens browser, redirect back to "Authentication complete"
sankofa status                              # → prints project + endpoint + login state
```

**Expected:** `Logged in as <email>` + an endpoint of
`https://api.sankofa.dev` (NOT a local host).

---

## Step 4 — Create a brand-new Flutter app

```sh
cd ~/Desktop
flutter create --org dev.sankofa.e2e --project-name sankofa_e2e_demo sankofa_e2e_demo
cd sankofa_e2e_demo

# Confirm a vanilla Flutter app builds before we add anything
flutter pub get
flutter analyze                              # → 0 issues
```

**Expected:** Standard `Counter` Flutter app, `analyze` clean.

---

## Step 5 — `sankofa init --deploy`

This is the core CLI flow we just shipped in 0.2.0. It will:

1. Sparse-clone `standalone/dynamic_modules` → `.sankofa/dynamic_modules/`
2. Add `.sankofa/` to `.gitignore`
3. Write `sankofa_flutter: ^0.2.1` to `dependencies:`
4. Write `dependency_overrides:` block (no GitHub URL — points at the vendor dir)
5. Add `sankofa.yaml` to `flutter.assets`
6. Create `sankofa.yaml` with `app_id` + `api_key` placeholders
7. Edit `lib/main.dart`: add imports + `registerLoader` + `preFlight`

```sh
sankofa init --deploy
```

**Expected output (approx, line order may vary):**

```
✔ Detected Flutter project at .
✔ Vendored package:dynamic_modules → .sankofa/dynamic_modules
✔ Added .sankofa/ to .gitignore
✔ Wrote sankofa_flutter ^0.2.1 to pubspec.yaml
✔ Wrote dependency_overrides for dynamic_modules
✔ Added sankofa.yaml to flutter.assets
✔ Created sankofa.yaml (with placeholders — fill in app_id + api_key)
✔ Wired lib/main.dart (registerLoader + preFlight)
```

---

## Step 6 — Inspect what the CLI wrote

You should be able to read everything it did from disk.

```sh
# 6a — pubspec.yaml has the SDK dep + override block (NO GitHub URL)
sed -n '/^dependencies:/,/^$/p' pubspec.yaml
sed -n '/^dependency_overrides:/,/^$/p' pubspec.yaml

# 6b — sankofa.yaml has placeholders waiting for real values
cat sankofa.yaml

# 6c — main.dart has the two-line boot ritual
sed -n '1,15p' lib/main.dart

# 6d — vendor dir exists with the binding
cat .sankofa/dynamic_modules/lib/dynamic_modules.dart

# 6e — gitignore was extended
grep -A0 sankofa .gitignore
```

**Expected:**

- pubspec deps include `sankofa_flutter: ^0.2.1`
- `dependency_overrides:` block:
  ```yaml
  dependency_overrides:
    dynamic_modules:
      path: .sankofa/dynamic_modules
  ```
- `sankofa.yaml` body:
  ```yaml
  app_id: proj_xxxxxxxxxxxxx
  api_key: sk_live_xxxxxxxxxxxxxxxx
  ```
- `lib/main.dart` head:
  ```dart
  import 'package:dynamic_modules/dynamic_modules.dart';
  import 'package:sankofa_flutter/sankofa_flutter.dart';
  import 'package:flutter/material.dart';

  Future<void> main() async {
    WidgetsFlutterBinding.ensureInitialized();
    SankofaUpdater.registerLoader(loadModuleFromBytes);
    await SankofaUpdater.preFlight();
    runApp(const MyApp());
  }
  ```
- `.sankofa/dynamic_modules/lib/dynamic_modules.dart` contains
  `loadModuleFromUri` + `loadModuleFromBytes` wrappers around
  `dart:_internal`.
- `.gitignore` contains a `.sankofa/` entry.

---

## Step 7 — Drop in your real project credentials

```sh
# Look up the project's API key in the dashboard, then:
$EDITOR sankofa.yaml
# Replace placeholders with real values:
#   app_id: proj_...
#   api_key: sk_live_...
```

---

## Step 8 — `pub get` against the real published SDK

```sh
flutter pub get
flutter analyze                              # → 0 issues
```

**Expected:** `Got dependencies!` with a `sankofa_flutter 0.2.1` line.
`flutter analyze` is clean — proves the override + vendored binding
type-checks against pub.dev's 0.2.1 surface.

---

## Step 9 — Doctor sanity check

```sh
sankofa doctor
```

**Expected:** green check marks for sankofa.yaml syntax, deploy
config, vendor dir, dart-side wire-up. Any reds here mean Step 5/6
diverged.

---

## Step 10 — Run on a device

```sh
# Plug in a real iPhone or Android phone (the simulator/emulator won't
# fully exercise the native plugin bridges).
flutter devices
flutter run -d <device-id> --release        # release exercises the LateInit fix
```

**Expected in the device logs (`flutter logs` or Xcode console):**

```
[Sankofa] handshake → https://api.sankofa.dev/api/v1/handshake
[Sankofa] handshake OK in <N>ms — modules: analytics, deploy, catch, switch, config, pulse, replay
[Sankofa] preFlight: no staged patch
[Sankofa] auto-confirm scheduled (post-first-frame)
```

App should render the Counter UI. No `LateInitializationError`,
no missing-podspec errors, no `Invalid external texture` spam.

---

## Step 11 — Verify it shows up on the dashboard

Open https://app.sankofa.dev → your project → **Analytics** tab.
Within ~30 seconds of the app launching you should see:

- A device session
- An `app_open` event
- The device's platform + app version

If you tap around the Counter, the `track` events flow too.

---

## Step 12 — (Optional) full Deploy round-trip with the Sankofa-forked engine

This is the Tier-A bytecode patch loop. Skip this if you just want
the integration sanity test — Step 10 + 11 prove every product
except Deploy bytecode apply works.

```sh
# 12a — install the bundled Sankofa Flutter SDK + engine binaries
sankofa engine install
sankofa engine list                          # → at least one Android + one iOS engine
$(sankofa engine path)/flutter/bin/flutter --version

# 12b — point this project at the bundled SDK
cat > .sankofa/flutter-version <<<"$(cat ~/.sankofa/flutter/*/VERSION 2>/dev/null | head -1)"

# 12c — build with the bundled SDK
$(sankofa engine path)/flutter/bin/flutter clean
$(sankofa engine path)/flutter/bin/flutter run -d <device-id> --release
```

Then on a second terminal, make a UI change in `lib/main.dart` and:

```sh
sankofa patch android      # or `sankofa patch ios`
```

Relaunch the app on the device — the new UI should appear without
rebuilding the binary.

---

## What to do if something diverges

| Symptom | Likely cause | Fix |
|---|---|---|
| `sankofa --version` not `0.2.0` after step 2 | Stale npm cache | `npm cache clean --force && npm i -g sankofa-cli@0.2.0` |
| `pub get` complains about `dynamic_modules` | Vendor dir missing or `dependency_overrides` not written | Re-run `sankofa init --deploy --force` |
| App crashes on launch with `LateInitializationError` | Old `sankofa_flutter` resolved (<0.2.1) | `flutter clean && rm -rf ~/.pub-cache/hosted/pub.dev/sankofa_flutter-0.2.0 && flutter pub get` |
| `pod install` fails with `No podspec found for sankofa_flutter` | Same as above (0.2.0 was missing podspec) | Same fix |
| No handshake fires | `sankofa.yaml` still has placeholders | Edit it with real `app_id` + `api_key` |
