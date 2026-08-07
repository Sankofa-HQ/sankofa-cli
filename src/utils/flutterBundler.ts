import { execSync } from 'child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { ensureEngineVersionStampedInYaml, resolveBundledFlutter, resolvePinnedEngineVersion } from './flutterBundleCache.js';
import { SANKOFA_STORAGE_BASE_URL, flutterVersionOf, DEFAULT_ENGINE_VERSION } from './engineVersion.js';
import { findStaleInterfaceEntries, scanPatchableLibraries } from './dartLibraryScan.js';

/**
 * Run a `flutter build …`, adding an actionable diagnostic for the one class of
 * failure a FRESH machine hits that a warm one never does: a plugin whose newest
 * version migrated to Flutter's "Built-in Kotlin". Flutter 3.44.1's Gradle
 * tooling doesn't apply KGP to such plugin projects, so the build dies with
 * `Unresolved reference: compilerOptions` (or `jvmTarget`) deep in Gradle output.
 * This is upstream 3.44.1 drift — stock Flutter fails identically — but the raw
 * error names nothing the customer can act on. We name the plugin and the
 * one-line `dependency_overrides` pin that fixes it. Sankofa already pins the one
 * such plugin the SDK itself pulls (shared_preferences_android); this covers any
 * OTHER plugin a customer adds.
 *
 * Only fires on the default (piped) path; verbose streams to the terminal, so
 * the caller already sees the raw error and `err` carries no captured output.
 */
function execFlutterBuild(cmd: string, cwd: string, verbose: boolean): void {
  try {
    execSync(cmd, { cwd, stdio: verbose ? 'inherit' : 'pipe' });
  } catch (err: any) {
    if (verbose) throw err;
    const out = `${err?.stdout?.toString?.() ?? ''}\n${err?.stderr?.toString?.() ?? ''}`;
    // Gradle/Kotlin phrase this two ways depending on version:
    //   "Unresolved reference: compilerOptions"   and   "Unresolved reference 'compilerOptions'"
    if (!/Unresolved reference:?\s*['"]?(compilerOptions|jvmTarget)/.test(out)) throw err;
    const plugin =
      out.match(/hosted[/\\]pub\.dev[/\\]([a-z0-9_]+)-\d+\.\d+\.\d+[/\\]/)?.[1] ??
      out.match(/Task :([a-z0-9_]+):compile\w*Kotlin/)?.[1] ??
      out.match(/([a-z0-9_]+)[/\\]android[/\\]build\.gradle/)?.[1] ??
      null;
    const name = plugin ?? '<the plugin named in the Gradle error above>';
    const lastGood = plugin === 'shared_preferences_android' ? '2.4.23' : '<its last pre-migration version>';
    throw new Error(
      `Android build failed: the plugin "${name}" uses Flutter's "Built-in Kotlin", which the\n` +
        `current Sankofa engine (Flutter 3.44.1) doesn't apply to plugin projects yet\n` +
        `(Gradle: "Unresolved reference: compilerOptions"). Stock Flutter 3.44.1 fails the same way.\n\n` +
        `Fix — pin the plugin to its last pre-migration version in pubspec.yaml, then\n` +
        `re-run \`flutter pub get\` and retry:\n` +
        `  dependency_overrides:\n` +
        `    ${name}: ${lastGood}\n\n` +
        `Remove the pin once your engine moves to a newer Flutter stable. (Sankofa already\n` +
        `pins shared_preferences_android for you.)`,
    );
  }
}

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
 * Resolve the `--dynamic-interface` build flags. The base app MUST be compiled
 * with `--extra-front-end-options=--dynamic-interface=<yaml>` so the AOT
 * precompiler RETAINS the functions a code-push patch may call (dart:core: ==,
 * ~/, +, toString, List, string-interp, …) instead of tree-shaking them. Without
 * it, a patch's bytecode can't resolve those references at transplant time on
 * device (proven: transplant then "Unable to find function == / toString").
 *
 * We ALSO pass `--dynamic-interface-annotate-privates`, without which only the
 * PUBLIC declaring-class member is retained (e.g. `Object.==`) but the concrete
 * private implementation the receiver actually dispatches to is tree-shaken
 * (`_IntegerImplementation.==`, `_StringBase`, `_GrowableList`, `_Smi`, …). A
 * patch's `a == b` bakes an InterfaceCall on `Object.==`; at runtime the
 * interpreter dispatches by NAME against the receiver's real class, so the
 * private impl must survive or `int == int` silently degrades to identity /
 * noSuchMethod. Retaining privates is what makes ARBITRARY core code correct,
 * not just non-crashing.
 * Convention: `<root>/sankofa_dynamic_interface.yaml` or
 * `<root>/sankofa/dynamic_interface.yaml`. Returns the flags or ''.
 */

/** `name:` from pubspec.yaml — the app's own package for the interface scan. */
function pubspecPackageName(projectRoot: string): string | undefined {
  try {
    const m = /^name:\s*(\S+)/m.exec(readFileSync(join(projectRoot, 'pubspec.yaml'), 'utf-8'));
    return m?.[1];
  } catch {
    return undefined;
  }
}

function dynamicInterfaceFlag(projectRoot: string): string {
  const yaml = [
    join(projectRoot, 'sankofa_dynamic_interface.yaml'),
    join(projectRoot, 'sankofa', 'dynamic_interface.yaml'),
  ].find((p) => existsSync(p));
  if (!yaml) {
    console.warn(
      '  ⚠ No sankofa_dynamic_interface.yaml — building WITHOUT --dynamic-interface. ' +
        'Code-push patches may fail to resolve dart:core/app calls at apply time. ' +
        'Add one declaring your patchable surface (callable/extendable).',
    );
    return '';
  }
  // PRE-FLIGHT: a `library:` entry whose file no longer exists is a hard build
  // failure, and the compiler blames the ENTRYPOINT, not the interface file:
  //
  //   lib/main_prod.dart: Error: Error when reading
  //   'lib/presentation/screens/chat/chat_page.dart': No such file or directory
  //
  // Nothing in that message mentions sankofa_dynamic_interface.yaml, so deleting
  // a screen silently breaks every subsequent Sankofa build with a diagnostic
  // pointing at the wrong file. Say it plainly here instead.
  try {
    const pkgName = pubspecPackageName(projectRoot);
    if (pkgName) {
      const scan = scanPatchableLibraries(projectRoot, pkgName);
      const stale = findStaleInterfaceEntries(readFileSync(yaml, 'utf-8'), pkgName, scan);
      if (stale.length > 0) {
        const lines = stale.map((u) => `      ${u}`).join('\n');
        throw new Error(
          `sankofa_dynamic_interface.yaml lists ${stale.length} librar${stale.length === 1 ? 'y' : 'ies'} that no longer exist:\n` +
            `${lines}\n\n` +
            `    Deleting or renaming a Dart file leaves the interface stale, and the\n` +
            `    compiler reports it against your entrypoint rather than this file.\n` +
            `    Remove those entries, or regenerate: delete ${yaml}\n` +
            `    and re-run \`sankofa init --deploy\`.`,
        );
      }
    }
  } catch (err: any) {
    // A genuine stale-entry error must surface; a scan that simply couldn't run
    // must not block the build.
    if (err instanceof Error && err.message.includes('sankofa_dynamic_interface.yaml lists')) {
      throw err;
    }
  }

  // NOTE: `--dynamic-interface-annotate-privates` (retains _IntegerImplementation.==,
  // _StringBase, _GrowableList, … so int/string/list ops are FULLY correct for a
  // patch, not just Smi-correct) exists in the engine's Dart 3.12 source but the
  // CURRENTLY BUNDLED frontend_server rejects it ("Could not find an option named
  // …"). Re-add it here once the bundle's frontend_server snapshot is rebuilt from
  // the engine's dart-sdk. Public `--dynamic-interface` alone retains Object.== so
  // the patch LOADS and Smi==Smi (canonical) is correct.
  return `--extra-front-end-options=--dynamic-interface=${yaml}`;
}

/**
 * Decide whether to pass `--no-tree-shake-icons`. Icon tree-shaking needs the
 * host `const_finder.dart.snapshot`, which the Sankofa engine bundle currently
 * doesn't ship — so a clean build fails in IconTreeShaker (`ConstFinder
 * failure`). Icon tree-shaking only subsets the icon FONT asset; it never
 * changes the Dart AOT. So we skip it (a) when the caller asks
 * (`treeShakeIcons:false`, e.g. the auto-diff patch rebuild), or (b)
 * transparently when const_finder is absent from the bundle — builds then
 * succeed and the OTA base/patch AOTs stay byte-identical. Once the engine
 * bundle ships const_finder, tree-shaking re-enables automatically. Returns the
 * flag (`--no-tree-shake-icons`) or '' .
 */
function resolveIconTreeShakeFlag(projectRoot: string, explicit?: boolean): string {
  if (explicit === false) return '--no-tree-shake-icons';
  try {
    const bundled = resolveBundledFlutter(projectRoot);
    if (bundled?.exists) {
      const root = dirname(dirname(bundled.bin)); // <root>/bin/flutter → <root>
      const engArt = join(root, 'bin', 'cache', 'artifacts', 'engine');
      const present =
        existsSync(join(engArt, 'darwin-x64', 'const_finder.dart.snapshot')) ||
        existsSync(join(engArt, 'darwin-arm64', 'const_finder.dart.snapshot'));
      if (!present) {
        console.warn(
          '  ⚠ const_finder not in the Sankofa engine bundle — building with --no-tree-shake-icons ' +
            '(icon font not subsetted; the OTA AOT is unaffected).',
        );
        return '--no-tree-shake-icons';
      }
    }
  } catch {
    /* couldn't resolve the bundle — let flutter tree-shake and surface its own error */
  }
  return '';
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

  // Resolution priority: explicit env override > the project's authoritative pin
  // (sankofa.yaml / .sankofa/flutter-version) > the current default engine. The
  // pin is honoured whenever it's set — NOT only when `flutter --version` is
  // broken — so a project that pins sankofa-2 never silently falls back to an
  // older engine. Last resort is DEFAULT_ENGINE_VERSION (the current release),
  // never a hardcoded stale suffix.
  const override = process.env.SANKOFA_ENGINE_VERSION;
  let sankofaEngineVersion: string;
  if (override) {
    sankofaEngineVersion = override;
  } else if (pinned) {
    sankofaEngineVersion = pinned;
  } else {
    sankofaEngineVersion = DEFAULT_ENGINE_VERSION;
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
  /**
   * Absolute path to the base program kernel (`app.dill`) captured from this
   * release build, or null if it couldn't be found. This is the no-AOT kernel
   * the auto-diff patch flow compiles a *changed* app against (`--import-dill`)
   * so it can diff the rebuilt AOT against the exact base program and ship only
   * the changed functions (dispatch-funcreg). It's the base half of the
   * "edit real code → auto-diff → live" pipeline; without it we fall back to
   * the limited patch-file model. Flutter writes it under
   * `.dart_tool/flutter_build/<hash>/app.dill` and discards it; we snapshot it.
   */
  appDillPath: string | null;
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
    /**
     * Icon tree-shaking. Default true (matches `flutter build`). Pass false to
     * add `--no-tree-shake-icons` — used by the auto-diff patch rebuild, which
     * only needs the AOT (`libapp.so`). Icon tree-shaking merely subsets the
     * icon FONT asset; it never changes the Dart AOT, so disabling it leaves the
     * base↔patch code diff identical while avoiding the `const_finder` host tool
     * (absent from the Sankofa engine bundle — a clean tree-shake build fails on
     * it). Not for store artifacts, where the smaller font is worth keeping.
     */
    treeShakeIcons?: boolean;
  } = { outputDir: 'build' },
): BuildAndExtractResult {
  const cwd = resolve(projectRoot);
  const outputDir = resolve(opts.outputDir);
  const format: FlutterBuildFormat = opts.format ?? 'aab';
  mkdirSync(outputDir, { recursive: true });
  // Stamp engine_version into sankofa.yaml before the build packs it —
  // the SDK reports it on /api/deploy/check at runtime.
  ensureEngineVersionStampedInYaml(cwd);

  const appVersion = detectFlutterAppVersion(cwd);
  const engine = detectFlutterEngineInfo(cwd);

  // Optional --dart-define passthrough (e.g. SANKOFA_SKIP_ENGINE_CHECK=1).
  // Auto-inject SANKOFA_FLAVOR on flavored builds so the SDK reports the
  // flavor at runtime and Deploy scopes OTA per flavor — the caller's
  // existing --flavor drives it, no extra flag or app-code change needed.
  const allDefines = [...(opts.dartDefines ?? [])];
  if (opts.flavor && !allDefines.some((d) => d.startsWith('SANKOFA_FLAVOR='))) {
    allDefines.push(`SANKOFA_FLAVOR=${opts.flavor}`);
  }
  const defineFlags = allDefines.map((d) => ` --dart-define=${d}`).join('');

  // Flavor + entry-point passthrough. Flavor names are alphanumeric
  // gradle identifiers (no quoting); the target is a path (quote for
  // spaces). Both apply to apk + appbundle so the store artifact and the
  // libapp.so we extract come from the same variant.
  const flavorFlag = opts.flavor ? ` --flavor ${opts.flavor}` : '';
  const targetFlag = opts.target ? ` --target "${opts.target}"` : '';
  // Skip icon tree-shaking when the caller asks or when const_finder is absent
  // from the bundle (AOT is unaffected, so the base↔patch diff is unchanged).
  const isf = resolveIconTreeShakeFlag(cwd, opts.treeShakeIcons);
  const iconFlag = isf ? ` ${isf}` : '';
  // Retain the code-push patchable surface so patches resolve their refs on device.
  const di = dynamicInterfaceFlag(cwd);
  const diFlag = di ? ` ${di}` : '';
  const variantFlags = `${defineFlags}${flavorFlag}${targetFlag}${iconFlag}${diFlag}`;

  // Always build the APK (cheap when AAB build is also queued — Flutter
  // shares the build graph). We need it to extract libapp.so +
  // AndroidManifest + flutter_assets for Diff Guard.
  const apkCmd = flutterCmd(cwd, `build apk --release --target-platform android-arm64${variantFlags}`);
  if (opts.verbose) console.log(`  $ ${apkCmd}`);
  execFlutterBuild(apkCmd, cwd, !!opts.verbose);

  // For 'aab' format, also build the AAB. This is the actual store
  // artifact for Play Console.
  let aabPath: string | null = null;
  if (format === 'aab') {
    const aabCmd = flutterCmd(cwd, `build appbundle --release --target-platform android-arm64${variantFlags}`);
    if (opts.verbose) console.log(`  $ ${aabCmd}`);
    execFlutterBuild(aabCmd, cwd, !!opts.verbose);
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

  // Snapshot the base program kernel (`app.dill`) this build produced. It's
  // the `--import-dill` input the auto-diff patch flow compiles the changed
  // source against, so `sankofa patch` can diff a rebuilt app vs the exact
  // base program and ship only the changed functions. Flutter leaves it in
  // `.dart_tool/flutter_build/<hash>/app.dill` (multiple hashes accumulate
  // across builds); we take the freshest one — the release build we just ran.
  const appDillPath = captureBaseAppDill(projectRoot, outputDir, engine.sankofaEngineVersion);

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
    appDillPath,
  };
}

/**
 * Find the freshest `app.dill` Flutter wrote under
 * `<projectRoot>/.dart_tool/flutter_build/<hash>/app.dill` and copy it to
 * `<outputDir>/app.<engineVersion>.dill`. Returns the copied path, or null if
 * no kernel was found (best-effort — the auto-diff flow degrades gracefully).
 *
 * `.dart_tool/flutter_build/` accumulates one directory per build config hash;
 * the release build we just ran leaves the newest `app.dill`, so we pick by
 * mtime rather than guessing the hash.
 */
function captureBaseAppDill(
  projectRoot: string,
  outputDir: string,
  engineVersion: string,
): string | null {
  try {
    const fbRoot = join(projectRoot, '.dart_tool', 'flutter_build');
    if (!existsSync(fbRoot)) return null;
    let newest: { path: string; mtime: number } | null = null;
    for (const entry of readdirSync(fbRoot)) {
      const cand = join(fbRoot, entry, 'app.dill');
      if (!existsSync(cand)) continue;
      const mtime = statSync(cand).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: cand, mtime };
    }
    if (!newest) return null;
    const finalDill = join(outputDir, `app.${engineVersion}.dill`);
    if (existsSync(finalDill)) rmSync(finalDill, { force: true });
    copyFileSync(newest.path, finalDill);
    return finalDill;
  } catch {
    // Best-effort: a missing base kernel just forces the patch-file fallback.
    return null;
  }
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
  /**
   * Absolute path to the base program AOT snapshot (the `App` Mach-O inside
   * `App.framework`), copied out of the archive, or null if not found. This is
   * the iOS equivalent of Android's `libapp.so` — the base half of the auto-diff
   * pipeline: `sankofa patch` runs `analyze_snapshot` on it and the rebuilt
   * patch AOT to compute the changed-function set (dispatch-funcreg). Stored so
   * a later patch can diff against the exact base program.
   */
  baseAotPath: string | null;
  /**
   * Absolute path to the base program kernel (`app.dill`) captured from this
   * build, or null. The `--import-dill` input the auto-diff patch compiles the
   * changed source against. See BuildAndExtractResult.appDillPath.
   */
  appDillPath: string | null;
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
    /** Icon tree-shaking (default true). false → `--no-tree-shake-icons`; see buildFlutterAOT. */
    treeShakeIcons?: boolean;
    verbose?: boolean;
  } = {},
): BuildIpaResult {
  const cwd = resolve(projectRoot);
  const appVersion = detectFlutterAppVersion(cwd);
  const engine = detectFlutterEngineInfo(cwd);
  // Stamp engine_version into sankofa.yaml before the build packs it —
  // the SDK reports it on /api/deploy/check at runtime.
  ensureEngineVersionStampedInYaml(cwd);

  const flags = ['build', 'ipa', '--release'];
  if (opts.codesign === false) flags.push('--no-codesign');
  const isf = resolveIconTreeShakeFlag(cwd, opts.treeShakeIcons);
  if (isf) flags.push(isf);
  // Retain the code-push patchable surface so patches resolve their refs on device.
  const di = dynamicInterfaceFlag(cwd);
  if (di) flags.push(di);
  if (opts.flavor) flags.push(`--flavor ${opts.flavor}`);
  if (opts.target) flags.push(`--target "${opts.target}"`);
  const iosDefines = [...(opts.dartDefines ?? [])];
  // Auto-inject SANKOFA_FLAVOR so the iOS build reports its flavor at
  // runtime (Deploy scopes OTA per flavor). Mirrors the Android path.
  if (opts.flavor && !iosDefines.some((d) => d.startsWith('SANKOFA_FLAVOR='))) {
    iosDefines.push(`SANKOFA_FLAVOR=${opts.flavor}`);
  }
  for (const d of iosDefines) flags.push(`--dart-define=${d}`);
  if (opts.exportOptionsPlist) flags.push(`--export-options-plist "${opts.exportOptionsPlist}"`);

  const cmd = flutterCmd(cwd, flags.join(' '));
  if (opts.verbose) console.log(`  $ ${cmd}`);
  // Inherit stdio — an iOS archive+export is a long, signing-sensitive build;
  // streaming xcodebuild output is far more useful than a silent spinner.
  execSync(cmd, { cwd, stdio: 'inherit' });

  const ipaPath = findIpa(join(cwd, 'build', 'ios', 'ipa'));
  const xcarchivePath = findXcarchive(join(cwd, 'build', 'ios', 'archive'));

  // Capture the base AOT (App.framework/App Mach-O) + kernel (app.dill) so a
  // later `sankofa patch` can auto-diff the rebuilt app against this exact base
  // program and ship only the changed functions (dispatch-funcreg) — no patch
  // file. Best-effort: absence forces the limited patch-file fallback.
  const outDir = join(cwd, 'build', 'ios', 'sankofa');
  mkdirSync(outDir, { recursive: true });
  const baseAotPath = captureIosBaseAot(cwd, xcarchivePath, outDir, engine.sankofaEngineVersion);
  const appDillPath = captureBaseAppDill(cwd, outDir, engine.sankofaEngineVersion);
  return { ipaPath, xcarchivePath, appVersion, engine, baseAotPath, appDillPath };
}

/**
 * Locate the base program AOT — the `App` Mach-O inside `App.framework` — from
 * an iOS release build and copy it to `<outDir>/App.<engineVersion>.aot`.
 * Returns the copied path, or null if not found (best-effort).
 *
 * The archive is the reliable source: `<xcarchive>/Products/Applications/
 * <name>.app/Frameworks/App.framework/App`. Falls back to the intermediate
 * `build/ios/Release-iphoneos/App.framework/App` (present pre-archive/export).
 */
function captureIosBaseAot(
  cwd: string,
  xcarchivePath: string | null,
  outDir: string,
  engineVersion: string,
): string | null {
  try {
    const candidates: string[] = [];
    if (xcarchivePath) {
      const appsDir = join(xcarchivePath, 'Products', 'Applications');
      if (existsSync(appsDir)) {
        for (const app of readdirSync(appsDir)) {
          if (app.endsWith('.app')) {
            candidates.push(join(appsDir, app, 'Frameworks', 'App.framework', 'App'));
          }
        }
      }
    }
    candidates.push(join(cwd, 'build', 'ios', 'Release-iphoneos', 'App.framework', 'App'));
    const src = candidates.find((c) => existsSync(c));
    if (!src) return null;
    const dest = join(outDir, `App.${engineVersion}.aot`);
    if (existsSync(dest)) rmSync(dest, { force: true });
    copyFileSync(src, dest);
    return dest;
  } catch {
    return null;
  }
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
  // Stamp engine_version into sankofa.yaml before the build packs it —
  // the SDK reports it on /api/deploy/check at runtime.
  ensureEngineVersionStampedInYaml(cwd);

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
