import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';

export interface FlutterEngineInfo {
  flutterVersion: string;
  channel: string;
  engineRevision: string;
  /** What we send to the server as `engine_version`. e.g. "3.41.9+sankofa-1". */
  sankofaEngineVersion: string;
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
export function detectFlutterEngineInfo(): FlutterEngineInfo {
  const out = execSync('flutter --version --machine', { encoding: 'utf-8' });
  let parsed: any;
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = parseFlutterVersionFallback(execSync('flutter --version', { encoding: 'utf-8' }));
  }
  const flutterVersion = String(parsed.flutterVersion || parsed.version || 'unknown');
  const channel = String(parsed.channel || 'unknown');
  const engineRevision = String(parsed.engineRevision || parsed.engineSha || 'unknown');

  const override = process.env.SANKOFA_ENGINE_VERSION;
  const sankofaEngineVersion = override || `${flutterVersion}+sankofa-1`;

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
}

export type FlutterBuildFormat = 'aab' | 'apk';
export type FlutterPlatform = 'android' | 'ios';

/**
 * Resolve and validate the platform positional for Flutter release/patch.
 * Today only Android is supported; iOS lands in Phase 6 (engine build
 * pipeline + ios/ wiring). Prompts when no platform is given so the
 * command shape matches RN's `sankofa release [platform]`.
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
          { name: 'iOS (Phase 6 — not yet supported)', value: 'ios', disabled: 'Phase 6' },
        ],
      },
    ]);
    value = picked;
  }

  if (value === 'ios') {
    console.error(chalk.red('  ✖ iOS Flutter Code OTA is not yet implemented (Phase 6).'));
    console.error(chalk.dim('     Track progress: docs/ROADMAP.md → Phase 6.'));
    console.error(chalk.dim('     For now, run `sankofa release android` to ship the Android baseline.'));
    process.exit(1);
  }
  if (value !== 'android') {
    console.error(chalk.red(`  ✖ Unknown platform "${value}". Expected: android (or ios — Phase 6).`));
    process.exit(1);
  }
  return 'android';
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
  } = { outputDir: 'build' },
): BuildAndExtractResult {
  const cwd = resolve(projectRoot);
  const outputDir = resolve(opts.outputDir);
  const format: FlutterBuildFormat = opts.format ?? 'aab';
  mkdirSync(outputDir, { recursive: true });

  const appVersion = detectFlutterAppVersion(cwd);
  const engine = detectFlutterEngineInfo();

  // Always build the APK (cheap when AAB build is also queued — Flutter
  // shares the build graph). We need it to extract libapp.so +
  // AndroidManifest + flutter_assets for Diff Guard.
  const apkCmd = 'flutter build apk --release --target-platform android-arm64';
  if (opts.verbose) console.log(`  $ ${apkCmd}`);
  execSync(apkCmd, { cwd, stdio: opts.verbose ? 'inherit' : 'pipe' });

  // For 'aab' format, also build the AAB. This is the actual store
  // artifact for Play Console.
  let aabPath: string | null = null;
  if (format === 'aab') {
    const aabCmd = 'flutter build appbundle --release --target-platform android-arm64';
    if (opts.verbose) console.log(`  $ ${aabCmd}`);
    execSync(aabCmd, { cwd, stdio: opts.verbose ? 'inherit' : 'pipe' });
    aabPath = findAab(cwd);
  }

  const apkDir = join(cwd, 'build', 'app', 'outputs', 'flutter-apk');
  const apk = findApk(apkDir);
  if (!apk) {
    throw new Error(`No APK produced at ${apkDir}`);
  }

  // Unzip the parts of the APK we care about:
  //  - lib/arm64-v8a/libapp.so (the OTA payload)
  //  - AndroidManifest.xml (Diff Guard baseline)
  //  - assets/flutter_assets/* (Diff Guard baseline)
  const extractDir = join(outputDir, `apk-extract-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  try {
    execSync(
      `unzip -o -q "${apk}" "lib/arm64-v8a/libapp.so" "AndroidManifest.xml" "assets/flutter_assets/*" -d "${extractDir}"`,
      { stdio: opts.verbose ? 'inherit' : 'pipe' },
    );
  } catch (err: any) {
    throw new Error(
      `Failed to extract libapp.so from ${apk}: ${err.message}\n` +
        `(Check that the APK was built --release and includes the AOT lib for arm64-v8a.)`,
    );
  }

  const libappInExtract = join(extractDir, 'lib', 'arm64-v8a', 'libapp.so');
  if (!existsSync(libappInExtract)) {
    throw new Error(`libapp.so not found in extracted APK at ${libappInExtract}`);
  }

  const finalLibapp = join(outputDir, `libapp.${engine.sankofaEngineVersion}.so`);
  // Move libapp.so to its final name; keep the rest of the extracted
  // tree around for Diff Guard.
  execSync(`mv "${libappInExtract}" "${finalLibapp}"`);
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
  };
}

function findAab(projectRoot: string): string | null {
  // Flutter places release AABs under build/app/outputs/bundle/release/.
  const dir = join(projectRoot, 'build', 'app', 'outputs', 'bundle', 'release');
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir);
  const release = entries.find((e) => /\.aab$/.test(e));
  return release ? join(dir, release) : null;
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
