import { execSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { resolveBundledFlutter, resolvePinnedEngineVersion } from './flutterBundleCache.js';
import { SANKOFA_STORAGE_BASE_URL, flutterVersionOf } from './engineVersion.js';

export interface FlutterEngineInfo {
  flutterVersion: string;
  channel: string;
  engineRevision: string;
  /** What we send to the server as `engine_version`. e.g. "3.41.9+sankofa-1". */
  sankofaEngineVersion: string;
}

/**
 * Resolve which `flutter` binary to invoke for the active project.
 *
 * Order, most specific first:
 *   1. The Sankofa BUNDLED flutter at ~/.sankofa/flutter/<engine-version>/
 *      (resolved from the project's sankofa.yaml engine_version)
 *   2. The customer's own `flutter` on PATH (fallback for unconfigured
 *      projects, doctor, etc.)
 *
 * The bundled-first policy is the same isolation pattern Shorebird uses
 * — the customer's upstream Flutter dev loop is never touched, but
 * everything Sankofa runs goes through our fork.
 */
export function resolveFlutterBinary(projectRoot?: string): string {
  if (projectRoot) {
    const bundled = resolveBundledFlutter(projectRoot);
    if (bundled?.exists) {
      // The bundled fork's engine.version pins a Sankofa engine rev whose
      // artifacts exist only on Sankofa's CDN. Setting the env var here —
      // at the moment the bundled SDK is chosen — propagates it to every
      // child this process spawns (flutter, gradle, xcodebuild) WITHOUT
      // leaking it into invocations of the customer's own upstream
      // flutter, whose engine revs only exist on Google's storage.
      if (!process.env.FLUTTER_STORAGE_BASE_URL) {
        process.env.FLUTTER_STORAGE_BASE_URL = SANKOFA_STORAGE_BASE_URL;
      }
      return bundled.bin;
    }
  }
  return 'flutter';
}

function flutterCmd(projectRoot: string | undefined, args: string): string {
  const bin = resolveFlutterBinary(projectRoot);
  // Quote if path has spaces (uncommon, but homedir on macOS can have spaces).
  const quoted = /\s/.test(bin) ? `"${bin}"` : bin;
  return `${quoted} ${args}`;
}

/**
 * Detect the Flutter version + engine revision the dev is using. The
 * `+sankofa-N` suffix is appended because customer apps must be built
 * with the Sankofa engine fork; the suffix is added by our forked
 * `engine.cc` (Phase 3 marker) and shows up in the binary at runtime.
 *
 * For now we trust the engine fork is in use if the dev set the
 * SANKOFA_ENGINE_VERSION env var, or we fall back to appending
 * `+sankofa-1` to the upstream Flutter version. Phase 11 will tighten
 * this by reading the embedded version string from the customer's
 * `libflutter.so`.
 */
export function detectFlutterEngineInfo(projectRoot?: string): FlutterEngineInfo {
  const out = execSync(flutterCmd(projectRoot, '--version --machine'), { encoding: 'utf-8' });
  let parsed: any;
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = parseFlutterVersionFallback(
      execSync(flutterCmd(projectRoot, '--version'), { encoding: 'utf-8' }),
    );
  }
  let flutterVersion = String(parsed.flutterVersion || parsed.version || 'unknown');
  const channel = String(parsed.channel || 'unknown');
  const engineRevision = String(parsed.engineRevision || parsed.engineSha || 'unknown');

  // `flutter --version` is unreliable on a fork clone: the framework derives
  // its version from `git describe --match '*.*.*'`, which the per-stable
  // `v…+sankofa-N` identity tag hijacks → an unparseable string → flutter
  // reports `0.0.0-unknown`. When that happens, fall back to the project's
  // authoritative engine pin (sankofa.yaml / .sankofa/flutter-version), which
  // is exactly `<flutter-version>+sankofa-N`. This removes the need to pass
  // `--engine-version` on hosts whose `flutter --version` is broken. When
  // `flutter --version` IS valid, behaviour is unchanged.
  const versionUnusable =
    flutterVersion === 'unknown' || flutterVersion.startsWith('0.0.0');
  const pinned = projectRoot ? resolvePinnedEngineVersion(projectRoot) : null;
  if (versionUnusable && pinned) {
    flutterVersion = flutterVersionOf(pinned) ?? flutterVersion;
  }

  const override = process.env.SANKOFA_ENGINE_VERSION;
  let sankofaEngineVersion: string;
  if (override) {
    sankofaEngineVersion = override;
  } else if (versionUnusable && pinned) {
    sankofaEngineVersion = pinned;
  } else {
    sankofaEngineVersion = `${flutterVersion}+sankofa-1`;
  }

  return { flutterVersion, channel, engineRevision, sankofaEngineVersion };
}

function parseFlutterVersionFallback(stdout: string): any {
  const versionMatch = stdout.match(/Flutter\s+([^\s•]+)/);
  const channelMatch = stdout.match(/channel\s+(\S+)/);
  const engineMatch = stdout.match(/Engine\s+•\s+revision\s+(\S+)/);
  return {
    flutterVersion: versionMatch ? versionMatch[1] : 'unknown',
    channel: channelMatch ? channelMatch[1] : 'unknown',
    engineRevision: engineMatch ? engineMatch[1] : 'unknown',
  };
}

export interface BuildAndExtractResult {
  /** Absolute path to the extracted libapp.so. */
  libappPath: string;
  /** ABI of the extracted lib. Today always arm64-v8a. */
  abi: 'arm64-v8a' | 'armeabi-v7a' | 'x86_64';
  /** App version detected from pubspec.yaml. */
  appVersion: string;
  /** Engine info captured at build time. */
  engine: FlutterEngineInfo;
  /** Absolute path to the built APK (kept when keepApk: true and format = 'apk'). */
  apkPath: string | null;
  /** Absolute path to the built AAB (when format = 'aab'). */
  aabPath: string | null;
  /**
   * Path to a temp directory containing the APK's `AndroidManifest.xml`
   * and `assets/flutter_assets/` tree, extracted alongside libapp.so so
   * the Diff Guard can hash them. Caller is responsible for cleaning it
   * up; on `keepApk: false` it lives alongside the libapp until next
   * build clears the output dir.
   */
  apkContentsDir: string | null;
  /**
   * SHA256 of the `libflutter.so` embedded in the customer's APK.
   * Used by the release-time engine integrity check to verify the
   * customer built against a Sankofa-trusted engine — a release built
   * with vanilla Flutter would crash every device on patch install,
   * so we refuse to publish it.
   *
   * Hex-encoded lowercase, e.g. `2ca8b4f959de...`.
   */
  libflutterSha256: string;
  /** Absolute path to the extracted `libflutter.so` (for diagnostics). */
  libflutterPath: string;
  /** Byte size of the libflutter.so we hashed. */
  libflutterSizeBytes: number;
}

export type FlutterBuildFormat = 'aab' | 'apk';
export type FlutterPlatform = 'android' | 'ios';

/**
 * Resolve and validate the platform positional for Flutter release/patch.
 *
 * Android uses the Phase 5 libapp.so binary-diff path. iOS uses the
 * Path C KBC interpreter pipeline (β.0–η). Both are first-class
 * targets now; the dispatch happens in flutterPatch / flutterRelease
 * based on this return value.
 */
export async function resolveFlutterPlatform(
  platformArg: string | undefined,
): Promise<FlutterPlatform> {
  const chalk = (await import('chalk')).default;
  let value: string | undefined = platformArg?.toLowerCase();

  if (!value) {
    const inquirer = (await import('inquirer')).default;
    const { picked } = await inquirer.prompt([
      {
        type: 'list',
        name: 'picked',
        message: 'Target platform:',
        choices: [
          { name: 'Android', value: 'android' },
          { name: 'iOS', value: 'ios' },
        ],
      },
    ]);
    value = picked;
  }

  if (value !== 'android' && value !== 'ios') {
    console.error(chalk.red(`  ✖ Unknown platform "${value}". Expected: android | ios.`));
    process.exit(1);
  }
  return value;
}

/**
 * Build the Flutter Android APK and extract `libapp.so` for an OTA patch.
 *
 * Calls `flutter build apk --release --target-platform android-arm64` so
 * the output APK contains the AOT-compiled Dart code we want to push.
 * Then unzips the APK and extracts `lib/arm64-v8a/libapp.so` to the
 * provided output directory.
 *
 * The customer's APK build is incidental — for an OTA patch we only need
 * the `libapp.so` byte payload; the APK itself is discarded. For
 * `sankofa release` (baseline) the caller can keep the APK for store
 * submission.
 */
export function buildFlutterAOT(
  projectRoot: string,
  opts: {
    outputDir: string;
    keepApk?: boolean;
    verbose?: boolean;
    /**
     * Build format. `aab` produces an Android App Bundle (the store
     * artifact for Play Console); `apk` produces a sideload-installable
     * APK. Default `aab`. Either way we still need an APK on disk to
     * extract `libapp.so` + AndroidManifest + flutter_assets for the
     * Diff Guard, so when `format === 'aab'` we ALSO build the APK
     * silently — Flutter does this fast on a warm cache.
     */
    format?: FlutterBuildFormat;
    /**
     * Extra `--dart-define=KEY=VALUE` entries to thread into the Flutter
     * build. Used today to bake `SANKOFA_SKIP_ENGINE_CHECK=1` into the
     * host binary while the Sankofa engine fork's Dart version string is
     * still unstamped (`Platform.version` lacks `+sankofa-N`). Once the
     * fork stamps `tools/VERSION`, this bypass is no longer needed.
     */
    dartDefines?: string[];
    /**
     * Android product flavor (e.g. `staging`, `production`). Threaded
     * through as `flutter build apk/appbundle --flavor <name>`. Required
     * for apps that define gradle product flavors — without it the build
     * fails ("you must specify a --flavor"). Flutter flavor names are
     * alphanumeric identifiers, so no shell-quoting is needed.
     */
    flavor?: string;
    /**
     * App entry-point file (e.g. `lib/main_staging.dart`). Threaded
     * through as `--target <file>`. Flavored apps typically pair a flavor
     * with a per-flavor entrypoint; without this they'd build the wrong
     * `main()` (or fail when there is no `lib/main.dart`).
     */
    target?: string;
  } = { outputDir: 'build' },
): BuildAndExtractResult {
  const cwd = resolve(projectRoot);
  const outputDir = resolve(opts.outputDir);
  const format: FlutterBuildFormat = opts.format ?? 'aab';
  mkdirSync(outputDir, { recursive: true });

  const appVersion = detectFlutterAppVersion(cwd);
  const engine = detectFlutterEngineInfo(cwd);

  // Optional --dart-define passthrough (e.g. SANKOFA_SKIP_ENGINE_CHECK=1).
  const defineFlags = (opts.dartDefines ?? [])
    .map((d) => ` --dart-define=${d}`)
    .join('');

  // Flavor + entry-point passthrough. Flavor names are alphanumeric
  // gradle identifiers (no quoting); the target is a path (quote for
  // spaces). Both apply to apk + appbundle so the store artifact and the
  // libapp.so we extract come from the same variant.
  const flavorFlag = opts.flavor ? ` --flavor ${opts.flavor}` : '';
  const targetFlag = opts.target ? ` --target "${opts.target}"` : '';
  const variantFlags = `${defineFlags}${flavorFlag}${targetFlag}`;

  // Always build the APK (cheap when AAB build is also queued — Flutter
  // shares the build graph). We need it to extract libapp.so +
  // AndroidManifest + flutter_assets for Diff Guard.
  const apkCmd = flutterCmd(cwd, `build apk --release --target-platform android-arm64${variantFlags}`);
  if (opts.verbose) console.log(`  $ ${apkCmd}`);
  execSync(apkCmd, { cwd, stdio: opts.verbose ? 'inherit' : 'pipe' });

  // For 'aab' format, also build the AAB. This is the actual store
  // artifact for Play Console.
  let aabPath: string | null = null;
  if (format === 'aab') {
    const aabCmd = flutterCmd(cwd, `build appbundle --release --target-platform android-arm64${variantFlags}`);
    if (opts.verbose) console.log(`  $ ${aabCmd}`);
    execSync(aabCmd, { cwd, stdio: opts.verbose ? 'inherit' : 'pipe' });
    aabPath = findAab(cwd, opts.flavor);
  }

  const apkDir = join(cwd, 'build', 'app', 'outputs', 'flutter-apk');
  const apk = findApk(apkDir);
  if (!apk) {
    throw new Error(`No APK produced at ${apkDir}`);
  }

  // Unzip the parts of the APK we care about:
  //  - lib/arm64-v8a/libapp.so      — the OTA payload
  //  - lib/arm64-v8a/libflutter.so  — the Sankofa engine (for trust check)
  //  - AndroidManifest.xml          — Diff Guard baseline
  //  - assets/flutter_assets/*      — Diff Guard baseline
  const extractDir = join(outputDir, `apk-extract-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  // Extract the APK contents. Unix has `unzip`; Windows ships `tar` (bsdtar /
  // libarchive), which reads zip archives — so on Windows we extract the whole
  // APK with tar (the extra entries are harmless in this throwaway temp dir).
  // GNU tar (Linux) can't read zip, so Unix keeps `unzip`.
  const extractCmd = process.platform === 'win32'
    ? `tar -xf "${apk}" -C "${extractDir}"`
    : `unzip -o -q "${apk}" "lib/arm64-v8a/libapp.so" "lib/arm64-v8a/libflutter.so" "AndroidManifest.xml" "assets/flutter_assets/*" -d "${extractDir}"`;
  try {
    execSync(extractCmd, { stdio: opts.verbose ? 'inherit' : 'pipe' });
  } catch (err: any) {
    throw new Error(
      `Failed to extract the native libraries from ${apk}: ${err.message}\n` +
        `(Check that the APK was built --release and includes the AOT libs for arm64-v8a.)`,
    );
  }

  const libappInExtract = join(extractDir, 'lib', 'arm64-v8a', 'libapp.so');
  if (!existsSync(libappInExtract)) {
    throw new Error(
      `Flutter binary not found in the built APK.\n` +
      `This usually means the Flutter build did not produce an AOT binary — ` +
      `check the build output for errors.`,
    );
  }
  const libflutterInExtract = join(extractDir, 'lib', 'arm64-v8a', 'libflutter.so');
  if (!existsSync(libflutterInExtract)) {
    throw new Error(
      `libflutter.so not found in extracted APK at ${libflutterInExtract}.\n` +
        `This is unusual — Flutter release APKs always bundle the engine. ` +
        `Did the APK come from a non-Flutter build, or was an unusual --target-platform used?`,
    );
  }

  // Hash libflutter.so before we move it — file streams are easier on
  // the original location. Engines are ~150 MB on Android arm64, so
  // streaming + chunked update keeps the working set bounded.
  const libflutterSha256 = sha256OfFile(libflutterInExtract);
  const libflutterSize = statSync(libflutterInExtract).size;

  const finalLibapp = join(outputDir, `libapp.${engine.sankofaEngineVersion}.so`);
  const finalLibflutter = join(outputDir, `libflutter.${engine.sankofaEngineVersion}.so`);
  // Move libapp.so + libflutter.so to their final names; keep the rest
  // of the extracted tree around for Diff Guard. (Node fs.renameSync —
  // cross-platform; the previous `mv` shell-out failed on Windows.)
  if (existsSync(finalLibapp)) rmSync(finalLibapp, { force: true });
  if (existsSync(finalLibflutter)) rmSync(finalLibflutter, { force: true });
  renameSync(libappInExtract, finalLibapp);
  renameSync(libflutterInExtract, finalLibflutter);
  // Drop the now-empty lib/arm64-v8a/ but keep AndroidManifest.xml +
  // assets/flutter_assets/.
  rmSync(join(extractDir, 'lib'), { recursive: true, force: true });

  return {
    libappPath: finalLibapp,
    abi: 'arm64-v8a',
    appVersion,
    engine,
    apkPath: opts.keepApk ? apk : null,
    aabPath,
    apkContentsDir: extractDir,
    libflutterSha256,
    libflutterPath: finalLibflutter,
    libflutterSizeBytes: libflutterSize,
  };
}

export interface BuildIpaResult {
  /** Absolute path to the produced `.ipa`, or null with --no-codesign / when export is deferred to Xcode. */
  ipaPath: string | null;
  /** Absolute path to the `.xcarchive` (always produced by `flutter build ipa`). */
  xcarchivePath: string | null;
  /** App version from pubspec.yaml — the iOS baseline's `target_binary_version`. */
  appVersion: string;
  /** Engine info captured at build time. */
  engine: FlutterEngineInfo;
}

/**
 * Build a signed iOS `.ipa` for App Store submission via `flutter build ipa`.
 *
 * Unlike the Android path (which extracts `libapp.so` as the OTA baseline
 * payload), the iOS `.ipa` is purely the developer's STORE artifact — Sankofa
 * never stores it and devices never download it. The iOS OTA baseline is a
 * signed KBC envelope registered separately (see flutterReleaseIOS in
 * release.ts), because iOS OTA runs through the bytecode interpreter, not a
 * native `libapp.so` swap.
 *
 * `flutter build ipa` runs xcodebuild archive + export under the hood:
 *   - with signing configured → build/ios/ipa/*.ipa (and the .xcarchive)
 *   - with --no-codesign       → build/ios/archive/Runner.xcarchive only
 *     (sign + export later via Xcode's Distribute App flow)
 *
 * `--flavor` / `--target` are threaded through identically to the Android
 * path so flavored apps (gradle flavors + per-flavor entrypoint) build the
 * right variant.
 */
export function buildFlutterIPA(
  projectRoot: string,
  opts: {
    flavor?: string;
    target?: string;
    dartDefines?: string[];
    /** Default true. false → pass `--no-codesign` (archive only; sign in Xcode). */
    codesign?: boolean;
    /** Path to an ExportOptions.plist forwarded to `flutter build ipa`. */
    exportOptionsPlist?: string;
    verbose?: boolean;
  } = {},
): BuildIpaResult {
  const cwd = resolve(projectRoot);
  const appVersion = detectFlutterAppVersion(cwd);
  const engine = detectFlutterEngineInfo(cwd);

  const flags = ['build', 'ipa', '--release'];
  if (opts.codesign === false) flags.push('--no-codesign');
  if (opts.flavor) flags.push(`--flavor ${opts.flavor}`);
  if (opts.target) flags.push(`--target "${opts.target}"`);
  for (const d of opts.dartDefines ?? []) flags.push(`--dart-define=${d}`);
  if (opts.exportOptionsPlist) flags.push(`--export-options-plist "${opts.exportOptionsPlist}"`);

  const cmd = flutterCmd(cwd, flags.join(' '));
  if (opts.verbose) console.log(`  $ ${cmd}`);
  // Inherit stdio — an iOS archive+export is a long, signing-sensitive build;
  // streaming xcodebuild output is far more useful than a silent spinner.
  execSync(cmd, { cwd, stdio: 'inherit' });

  const ipaPath = findIpa(join(cwd, 'build', 'ios', 'ipa'));
  const xcarchivePath = findXcarchive(join(cwd, 'build', 'ios', 'archive'));
  return { ipaPath, xcarchivePath, appVersion, engine };
}

function findIpa(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const ipa = readdirSync(dir).find((e) => e.endsWith('.ipa'));
  return ipa ? join(dir, ipa) : null;
}

/**
 * Build an iOS **simulator** `.app` and zip it for `sankofa preview` from the
 * server. The server's preview-artifact slot is simulator-only for iOS
 * (`ios-simulator-app-zip`), so a device `.ipa` can't be used here. Built with
 * the bundled Sankofa fork (its xcframework includes the simulator slice), so
 * the previewed app carries the same engine a real release would.
 *
 * Returns the zip path + the app's bundle id (read from the built Info.plist,
 * the most reliable source) for the later `simctl launch`.
 */
export function buildFlutterIOSSimulatorApp(
  projectRoot: string,
  opts: { flavor?: string; target?: string; dartDefines?: string[]; outputDir: string; verbose?: boolean },
): { appZipPath: string; appId: string } {
  const cwd = resolve(projectRoot);
  const outDir = resolve(opts.outputDir);
  mkdirSync(outDir, { recursive: true });

  // `flutter build ios --simulator` produces a debug simulator build at
  // build/ios/iphonesimulator/Runner.app (no codesign needed for sims).
  const flags = ['build', 'ios', '--simulator'];
  if (opts.flavor) flags.push(`--flavor ${opts.flavor}`);
  if (opts.target) flags.push(`--target "${opts.target}"`);
  for (const d of opts.dartDefines ?? []) flags.push(`--dart-define=${d}`);
  const cmd = flutterCmd(cwd, flags.join(' '));
  if (opts.verbose) console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });

  const appPath = join(cwd, 'build', 'ios', 'iphonesimulator', 'Runner.app');
  if (!existsSync(appPath)) {
    throw new Error(
      `Simulator app not found at ${appPath} after \`flutter build ios --simulator\`.\n` +
        `(Your Sankofa engine build may not include an iOS simulator slice.)`,
    );
  }
  const appId = readBundleIdFromApp(appPath);
  const appZipPath = join(outDir, 'Runner-ios-simulator.app.zip');
  if (existsSync(appZipPath)) rmSync(appZipPath, { force: true });
  // Same packaging the RN path uses, so the server + preview install agree.
  execSync(`ditto -c -k --sequesterRsrc --keepParent "${appPath}" "${appZipPath}"`, {
    stdio: opts.verbose ? 'inherit' : 'pipe',
  });
  return { appZipPath, appId };
}

function readBundleIdFromApp(appPath: string): string {
  const plist = join(appPath, 'Info.plist');
  try {
    return execSync(`/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${plist}"`, {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Detect a Flutter app's NATIVE bundle id / package name (for `simctl launch`
 * / `adb shell monkey`). Android: `applicationId` in app/build.gradle[.kts].
 * iOS: `PRODUCT_BUNDLE_IDENTIFIER` from the Runner target's pbxproj (skipping
 * the test target and any `$(...)` variable form). Returns null if unknown —
 * callers fall back to an explicit `--app-id`.
 */
export function detectFlutterAppId(projectRoot: string, platform: 'ios' | 'android'): string | null {
  const cwd = resolve(projectRoot);
  if (platform === 'android') {
    for (const f of ['android/app/build.gradle.kts', 'android/app/build.gradle']) {
      const p = join(cwd, f);
      if (!existsSync(p)) continue;
      const m = readFileSync(p, 'utf-8').match(/applicationId\s*=?\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
    return null;
  }
  const pbx = join(cwd, 'ios', 'Runner.xcodeproj', 'project.pbxproj');
  if (!existsSync(pbx)) return null;
  const ids = Array.from(
    readFileSync(pbx, 'utf-8').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g),
  ).map((m) => m[1].trim());
  return ids.find((id) => !/test/i.test(id) && !id.includes('$(')) || ids[0] || null;
}

function findXcarchive(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const arch = readdirSync(dir).find((e) => e.endsWith('.xcarchive'));
  return arch ? join(dir, arch) : null;
}

/**
 * Stream-hash a file with SHA-256. Loads at most 64 KiB at a time so
 * a 150 MB `libflutter.so` doesn't allocate a contiguous buffer.
 */
function sha256OfFile(path: string): string {
  const hash = createHash('sha256');
  // We've already established the file exists. `readFileSync` reads the
  // whole file into memory, which we want to avoid for libflutter.so.
  // Node's `fs.openSync` + chunked reads keep the working set bounded.
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    while (true) {
      const bytes = readSync(fd, buf, 0, buf.length, null);
      if (bytes <= 0) break;
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function findAab(projectRoot: string, flavor?: string): string | null {
  // Plain builds write to build/app/outputs/bundle/release/; flavored
  // builds write to build/app/outputs/bundle/<flavor>Release/ (e.g.
  // stagingRelease/). Search the whole bundle/ dir so both layouts work.
  const bundleRoot = join(projectRoot, 'build', 'app', 'outputs', 'bundle');
  if (!existsSync(bundleRoot)) return null;

  const subdirs = readdirSync(bundleRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  // Prefer the flavor-specific release dir, then any *Release dir, then
  // anything else — so a flavored build never picks up a stale plain AAB.
  const preferred = flavor ? `${flavor}release` : '';
  const ordered = [
    ...subdirs.filter((d) => d.toLowerCase() === preferred),
    ...subdirs.filter((d) => d.toLowerCase() !== preferred && /release$/i.test(d)),
    ...subdirs.filter((d) => !/release$/i.test(d)),
  ];

  for (const sub of ordered) {
    const dir = join(bundleRoot, sub);
    const aab = readdirSync(dir).find((e) => /\.aab$/.test(e));
    if (aab) return join(dir, aab);
  }
  return null;
}

function findApk(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir);
  // Prefer release APK. flavors create app-<flavor>-release.apk.
  const release = entries.find((e) => /release\.apk$/.test(e));
  if (release) return join(dir, release);
  const anyApk = entries.find((e) => e.endsWith('.apk'));
  return anyApk ? join(dir, anyApk) : null;
}

/**
 * Parse the version line out of pubspec.yaml. Returns the segment before
 * the `+` (so `1.2.0+34` → `1.2.0`). This is what the server expects as
 * `target_binary_version`, matching what gets stamped into the APK's
 * versionName.
 */
export function detectFlutterAppVersion(projectRoot: string): string {
  const path = join(projectRoot, 'pubspec.yaml');
  if (!existsSync(path)) {
    throw new Error(`pubspec.yaml not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const m = raw.match(/^version:\s*([^\s#]+)/m);
  if (!m) {
    throw new Error(`No "version:" key in ${path}`);
  }
  const value = m[1];
  return value.split('+')[0];
}

/**
 * Read the `flutter_assets/` directory bundled into the built APK so the
 * Diff Guard can compare it byte-for-byte against the baseline.
 *
 * Returns a map of `<relative path> → sha256-hex`. Caller is responsible
 * for unzipping the APK first; we just walk the directory tree.
 */
export function hashFlutterAssetsTree(assetsDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(assetsDir)) return result;
  const stack: string[] = [assetsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        const rel = full.slice(assetsDir.length + 1);
        result[rel] = sha256File(full);
      }
    }
  }
  return result;
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function getFileSizeBytes(path: string): number {
  return statSync(path).size;
}
