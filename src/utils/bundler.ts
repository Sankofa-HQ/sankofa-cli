import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { createHash } from 'crypto';
import { resolveBuildEnv, logBuildEnv, type TargetPlatform } from './buildEnv.js';

export type Platform = 'ios' | 'android';

export type NativePreviewArtifactKind = 'ios-simulator-app-zip' | 'android-apk';

export interface NativePreviewArtifact {
  path: string;
  kind: NativePreviewArtifactKind;
}

const ENTRY_FILE_CANDIDATES = [
  'index.js',
  'index.ts',
  'index.tsx',
  'App.js',
  'App.ts',
  'App.tsx',
];

const ENTRY_EXTENSIONS = ['', '.ios.ts', '.native.ts', '.ts', '.ios.tsx', '.native.tsx', '.tsx', '.ios.js', '.native.js', '.js', '.ios.jsx', '.native.jsx', '.jsx'];

function entryExists(entryFile: string): boolean {
  return ENTRY_EXTENSIONS.some((ext) => existsSync(join(process.cwd(), `${entryFile}${ext}`)));
}

/**
 * Detect the native app version from the project files.
 *
 * Priority:
 * 1. app.json - expo.version (Expo projects)
 * 2. ios/Info.plist - CFBundleShortVersionString
 * 3. android/app/build.gradle - versionName
 */
function readAppJsonVersion(): string | null {
  const appJsonPath = join(process.cwd(), 'app.json');
  if (!existsSync(appJsonPath)) return null;
  try {
    const appJson = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
    return appJson.expo?.version || appJson.version || null;
  } catch {
    return null;
  }
}

function readNativeIOSVersion(): string | null {
  try {
    const plistOutput = execSync(
      `find ios -name Info.plist -not -path "*/Pods/*" -not -path "*/build/*" | head -1`,
      { encoding: 'utf-8' },
    ).trim();
    if (!plistOutput) return null;
    const version = execSync(
      `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${plistOutput}"`,
      { encoding: 'utf-8' },
    ).trim();
    return version || null;
  } catch {
    return null;
  }
}

function readNativeAndroidVersion(): string | null {
  const gradlePath = join(process.cwd(), 'android', 'app', 'build.gradle');
  if (existsSync(gradlePath)) {
    const content = readFileSync(gradlePath, 'utf-8');
    const match = content.match(/versionName\s+["'](.+?)["']/);
    if (match) return match[1];
  }
  const gradleKtsPath = join(process.cwd(), 'android', 'app', 'build.gradle.kts');
  if (existsSync(gradleKtsPath)) {
    const content = readFileSync(gradleKtsPath, 'utf-8');
    const match = content.match(/versionName\s*=\s*["'](.+?)["']/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Detect the version the *compiled native binary* will report at runtime.
 *
 * Native sources (Info.plist / build.gradle) win over app.json because the
 * SDK reads `CFBundleShortVersionString` / `PackageInfo.versionName` at
 * runtime — those are what the server matches `target_binary_version`
 * against. If app.json and the native binary disagree, the binary wins,
 * and we throw a loud error so the user knows to run `expo prebuild` or
 * bump the native version before publishing. Silently preferring app.json
 * has caused v1.0.4 apps to download v1.0.0 bundles and crash.
 */
export function detectAppVersion(platform: Platform): string | null {
  const appJsonVersion = readAppJsonVersion();
  const nativeVersion =
    platform === 'ios' ? readNativeIOSVersion() : readNativeAndroidVersion();

  if (nativeVersion) {
    if (appJsonVersion && appJsonVersion !== nativeVersion) {
      throw new Error(
        `Version mismatch: app.json says ${appJsonVersion} but the native ${platform} binary is built with ${nativeVersion}. ` +
          `The SDK reads the native version at runtime, so releases published against ${appJsonVersion} would never match this binary. ` +
          `Run \`npx expo prebuild --platform ${platform}\` (or bump the native version manually) so app.json and the native source agree, then try again.`,
      );
    }
    return nativeVersion;
  }

  // No native source yet (pre-prebuild): app.json is the best we have.
  return appJsonVersion;
}

export function detectEntryFile(explicitEntryFile?: string): string {
  if (explicitEntryFile) return explicitEntryFile;

  const packageJsonPath = join(process.cwd(), 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (typeof packageJson.main === 'string' && packageJson.main.trim()) {
        const main = packageJson.main.trim();
        if (entryExists(main)) return main;

        if (!main.startsWith('.') && !main.startsWith('/')) {
          const nodeModuleEntry = join('node_modules', main);
          if (entryExists(nodeModuleEntry)) return nodeModuleEntry;
        }

        return main;
      }
    } catch {}
  }

  const found = ENTRY_FILE_CANDIDATES.find((candidate) => existsSync(join(process.cwd(), candidate)));
  return found || 'index.js';
}

export function detectAppId(platform: Platform): string | null {
  const appJsonPath = join(process.cwd(), 'app.json');
  if (existsSync(appJsonPath)) {
    try {
      const appJson = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
      const appId = platform === 'ios'
        ? appJson.expo?.ios?.bundleIdentifier
        : appJson.expo?.android?.package;
      if (appId) return appId;
    } catch {}
  }

  if (platform === 'ios') {
    try {
      const plistOutput = execSync(
        `find ios -name Info.plist -not -path "*/Pods/*" -not -path "*/build/*" | head -1`,
        { encoding: 'utf-8' },
      ).trim();
      if (plistOutput) {
        const bundleID = execSync(
          `/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${plistOutput}"`,
          { encoding: 'utf-8' },
        ).trim();
        if (bundleID && !bundleID.includes('$(')) return bundleID;
      }
    } catch {}
  }

  if (platform === 'android') {
    const manifestPath = join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    if (existsSync(manifestPath)) {
      const content = readFileSync(manifestPath, 'utf-8');
      const match = content.match(/\bpackage=["']([^"']+)["']/);
      if (match) return match[1];
    }
  }

  return null;
}

/**
 * Clear the CLI's output directory so a release/patch never picks up a stale
 * bundle or native artifact from a previous run.
 *
 * We intentionally do NOT wipe Metro transformer caches, Pods, or the native
 * `ios/build`/`android/.gradle` directories anymore. Those caches are safe
 * now that the release pipeline extracts its OTA bundle directly from the
 * freshly-built native artifact (so Metro runs once, deterministically,
 * inside `xcodebuild`/`gradlew`) and the prebuild + version-mismatch guard
 * prevent cross-version state drift. Incremental native builds turn a 5-min
 * release back into a ~30-second one.
 */
export function clearBuildArtifacts(outputDir: string): void {
  if (existsSync(outputDir)) {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch {}
  }
  mkdirSync(outputDir, { recursive: true });
}

/**
 * Run `npx expo prebuild --platform <platform>` for Expo projects so the
 * native `ios/`/`android/` sources are regenerated from `app.json` before
 * every release/patch. Without this, bumping `app.json`'s version leaves
 * `Info.plist`/`build.gradle` stale, which causes the SDK to report the
 * old version at runtime and download cross-version bundles.
 *
 * Runs in non-interactive mode and avoids `--clean` so user edits to the
 * native projects (custom AppDelegate hooks, extra pods, etc.) are kept.
 */
export function syncNativeFromAppJson(platform: Platform): void {
  if (!projectUsesExpo()) return;
  try {
    execSync(
      `npx --no-install expo prebuild --platform ${platform} --no-install --non-interactive`,
      { stdio: 'inherit' },
    );
  } catch (err: any) {
    throw new Error(
      `\`expo prebuild --platform ${platform}\` failed. Install the Expo CLI in this project (\`npm install\`) and re-run. ` +
        `Original error: ${err?.message || err}`,
    );
  }
}

function projectUsesExpo(): boolean {
  if (existsSync(join(process.cwd(), 'node_modules', 'expo'))) return true;
  const pkgPath = join(process.cwd(), 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return !!deps.expo;
  } catch {
    return false;
  }
}

/**
 * Bundle the JS using Metro and emit every referenced asset alongside it.
 *
 * `outputDir` receives:
 *   - bundle.jsbundle   — the JS bundle
 *   - assets/…          — every asset Metro referenced (fonts, images, JSON…)
 *
 * Shipping assets in the OTA archive is what makes patches safe: the bundle's
 * asset paths (e.g. `assets/node_modules/.../SpaceMono.ttf`) resolve to files
 * that actually exist next to the bundle at runtime, instead of whatever
 * happens to be inside `Bundle.main`.
 *
 * Uses `npx --no-install` so a missing bundler fails loudly instead of
 * silently installing React Native into the current working directory.
 */
export function bundleJS(
  platform: Platform,
  entryFile: string,
  outputDir: string,
): { bundlePath: string; assetsDir: string } {
  mkdirSync(outputDir, { recursive: true });
  const bundlePath = join(outputDir, 'bundle.jsbundle');
  const assetsDir = join(outputDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });

  const isExpo = projectUsesExpo();
  const cli = isExpo ? 'expo export:embed' : 'react-native bundle';
  try {
    execSync(
      `npx --no-install ${cli} --platform ${platform} --entry-file ${entryFile} --bundle-output ${shellQuote(bundlePath)} --assets-dest ${shellQuote(outputDir)} --dev false`,
      { stdio: 'inherit' },
    );
  } catch (err: any) {
    const tool = isExpo ? 'expo' : 'react-native';
    throw new Error(
      `${tool} bundler is not available in ${process.cwd()}. ` +
        `Install project dependencies (e.g. \`npm install\`) in the React Native app directory before running this command.`,
    );
  }

  if (!existsSync(bundlePath)) {
    throw new Error(`Metro did not produce ${bundlePath}`);
  }
  return { bundlePath, assetsDir };
}

/**
 * Package a bundle + assets directory into a single `.zip` archive ready for
 * upload. The archive layout is intentionally flat so the SDK can unzip it
 * next to `bundle.jsbundle` and RN's AssetSourceResolver finds assets
 * relative to the bundle URL:
 *
 *   ota.zip
 *     bundle.jsbundle
 *     assets/
 *       …
 */
export function createOTAArchive(stageDir: string, archivePath: string): void {
  if (!existsSync(stageDir)) {
    throw new Error(`OTA stage dir does not exist: ${stageDir}`);
  }
  const bundlePath = join(stageDir, 'bundle.jsbundle');
  if (!existsSync(bundlePath)) {
    const contents = (() => {
      try {
        return readdirSync(stageDir).join(', ') || '(empty)';
      } catch {
        return '(unreadable)';
      }
    })();
    throw new Error(
      `OTA stage dir missing bundle.jsbundle.\n` +
        `  stageDir: ${stageDir}\n` +
        `  contents: ${contents}`,
    );
  }
  // Resolve to an absolute path: we run zip with `cwd = stageDir`, so a
  // relative `build/ota.ios.zip` would incorrectly resolve inside stageDir.
  const absoluteArchive = resolve(archivePath);
  if (existsSync(absoluteArchive)) {
    rmSync(absoluteArchive, { force: true });
  }
  try {
    execSync(`zip -r ${shellQuote(absoluteArchive)} .`, {
      cwd: stageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() || '';
    const stdout = err?.stdout?.toString?.() || '';
    throw new Error(
      `zip failed while creating ${absoluteArchive}.\n` +
        (stderr ? `stderr: ${stderr.trim()}\n` : '') +
        (stdout ? `stdout: ${stdout.trim()}\n` : ''),
    );
  }
  if (!existsSync(absoluteArchive)) {
    throw new Error(`Failed to create OTA archive at ${absoluteArchive}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function findFirstPath(root: string, predicate: (path: string) => boolean): string | null {
  if (!existsSync(root)) return null;
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (predicate(path)) return path;
    if (entry.isDirectory()) {
      const found = findFirstPath(path, predicate);
      if (found) return found;
    }
  }
  return null;
}

function findXcodeWorkspace(): string | null {
  const iosDir = join(process.cwd(), 'ios');
  const workspaces = readdirSync(iosDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcworkspace'))
    .map((entry) => join(iosDir, entry.name))
    .filter((path) => !path.includes('/Pods/'));
  return workspaces[0] || null;
}

function findXcodeProject(): string | null {
  const iosDir = join(process.cwd(), 'ios');
  const projects = readdirSync(iosDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))
    .map((entry) => join(iosDir, entry.name))
    .filter((path) => !path.includes('/Pods/'));
  return projects[0] || null;
}

function findXcodeScheme(): string | null {
  const iosDir = join(process.cwd(), 'ios');
  const schemePath = findFirstPath(iosDir, (path) =>
    path.endsWith('.xcscheme') &&
    !path.includes('/Pods/') &&
    !path.includes('/node_modules/'),
  );
  if (schemePath) return basename(schemePath, '.xcscheme');

  const appJsonPath = join(process.cwd(), 'app.json');
  if (existsSync(appJsonPath)) {
    try {
      const appJson = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
      const name = appJson.expo?.name || appJson.name;
      if (typeof name === 'string' && name.trim()) return name.trim().replace(/\s+/g, '');
    } catch {}
  }
  return null;
}

function findBuiltIOSApp(derivedDataPath: string): string | null {
  const productsDir = join(derivedDataPath, 'Build', 'Products', 'Release-iphonesimulator');
  return findFirstPath(productsDir, (path) => path.endsWith('.app'));
}

function findAppInDirectory(root: string): string | null {
  return findFirstPath(root, (path) => path.endsWith('.app'));
}

/**
 * Extract the JS bundle AND every asset that xcodebuild/gradlew embedded
 * inside the native artifact into `stageDir`, so they can be zipped into a
 * production-grade OTA archive. Using the freshly-built native bundle +
 * assets guarantees byte-identical asset IDs/paths between what's inside
 * the `.app` and what ships over the air — the OTA can never reference a
 * hash that doesn't exist in the native binary.
 *
 * Returns true when the native artifact yielded a usable bundle, false
 * otherwise (the caller should fall back to bundling from source).
 */
export function extractEmbeddedOTA(
  platform: Platform,
  artifactPath: string,
  stageDir: string,
): boolean {
  mkdirSync(stageDir, { recursive: true });

  if (platform === 'ios') {
    const extractDir = `${artifactPath}.extract-for-ota`;
    if (existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
    mkdirSync(extractDir, { recursive: true });
    try {
      execSync(`ditto -x -k ${shellQuote(artifactPath)} ${shellQuote(extractDir)}`, {
        stdio: 'inherit',
      });
      const appPath = findAppInDirectory(extractDir);
      if (!appPath) return false;
      const bundles = collectJSBundles(appPath);
      if (bundles.length === 0) return false;
      const preferred =
        bundles.find((p) => basename(p) === 'main.jsbundle') || bundles[0];
      copyFileSync(preferred, join(stageDir, 'bundle.jsbundle'));

      // Copy the entire `assets/` subtree out of the .app.
      const embeddedAssets = join(appPath, 'assets');
      if (existsSync(embeddedAssets)) {
        const dest = join(stageDir, 'assets');
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        execSync(`cp -R ${shellQuote(embeddedAssets)} ${shellQuote(dest)}`, { stdio: 'inherit' });
      }
      return true;
    } finally {
      try {
        rmSync(extractDir, { recursive: true, force: true });
      } catch {}
    }
  }

  if (platform === 'android') {
    // APK is a zip. Extract `assets/index.android.bundle` → bundle.jsbundle,
    // and everything else under `assets/` that RN packages as OTA-reachable.
    const unzipDir = `${artifactPath}.extract-for-ota`;
    if (existsSync(unzipDir)) {
      rmSync(unzipDir, { recursive: true, force: true });
    }
    mkdirSync(unzipDir, { recursive: true });
    try {
      // Unix: `unzip`. Windows: `tar` (bsdtar reads zips; GNU tar on Linux can't,
      // so Unix keeps unzip).
      const cmd = process.platform === 'win32'
        ? `tar -xf ${shellQuote(artifactPath)} -C ${shellQuote(unzipDir)}`
        : `unzip -o -q ${shellQuote(artifactPath)} -d ${shellQuote(unzipDir)}`;
      execSync(cmd, { stdio: 'inherit' });
      const bundleInApk = join(unzipDir, 'assets', 'index.android.bundle');
      if (!existsSync(bundleInApk)) return false;
      copyFileSync(bundleInApk, join(stageDir, 'bundle.jsbundle'));

      // Copy every drawable/raw/asset folder Metro wrote alongside the bundle.
      const apkAssets = join(unzipDir, 'assets');
      if (existsSync(apkAssets)) {
        const dest = join(stageDir, 'assets');
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        mkdirSync(dest, { recursive: true });
        // Skip the bundle itself; it's already at stageDir/bundle.jsbundle.
        execSync(
          `find ${shellQuote(apkAssets)} -mindepth 1 -not -name 'index.android.bundle' -maxdepth 1 -exec cp -R {} ${shellQuote(dest)} \\;`,
          { stdio: 'inherit', shell: '/bin/bash' } as any,
        );
      }
      return true;
    } finally {
      try {
        rmSync(unzipDir, { recursive: true, force: true });
      } catch {}
    }
  }

  return false;
}

function collectJSBundles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsbundle')) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}

/**
 * Build an installable native preview artifact without installing or launching.
 * The artifact is uploaded with a Deploy release so `sankofa preview` can install
 * exactly what was published, not rebuild the local source tree.
 */
export function buildNativePreviewArtifact(
  platform: Platform,
  outputDir: string,
): NativePreviewArtifact {
  mkdirSync(outputDir, { recursive: true });

  // Auto-detect build tooling (Android SDK, Java 17/21, adb on Android;
  // Xcode, CocoaPods on iOS). Works across macOS, Linux, Windows without
  // touching the user's shell rc files — env vars are injected into the
  // subprocess only. Missing tools produce a clean error with install
  // instructions rather than a 20-minute mystery gradle failure.
  const buildEnv = resolveBuildEnv(platform as TargetPlatform, { strict: true });
  // Log what we found (one line per detected path) so users can see why
  // a build "just worked" without them having set ANDROID_HOME.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chalk = require('chalk');
    logBuildEnv(buildEnv, chalk.default || chalk);
  } catch { /* chalk may not be available in some contexts */ }

  if (platform === 'ios') {
    const workspace = findXcodeWorkspace();
    const project = workspace ? null : findXcodeProject();
    const scheme = findXcodeScheme();
    if (!workspace && !project) {
      throw new Error('Could not find an iOS .xcworkspace or .xcodeproj under ios/. Run prebuild/pod install first.');
    }
    if (!scheme) {
      throw new Error('Could not detect an iOS scheme to build.');
    }

    // Always run `pod install`. CocoaPods is a no-op when Pods are already
    // in sync with Podfile.lock, and running it unconditionally means a
    // podspec change in a linked SDK (new pod dependency) never gets
    // silently skipped — which previously produced `undefined symbol`
    // errors from xcodebuild that looked unrelated to the missing pod.
    const iosDir = join(process.cwd(), 'ios');
    const podfileExists = existsSync(join(iosDir, 'Podfile'));
    if (podfileExists) {
      const podCmd = existsSync(join(iosDir, 'Gemfile')) ? 'bundle exec pod install' : 'pod install';
      execSync(podCmd, { cwd: iosDir, stdio: 'inherit', env: buildEnv.env });
    }

    const derivedDataPath = join(outputDir, 'sankofa-ios-preview-derived-data');
    const projectArg = workspace
      ? `-workspace ${shellQuote(workspace)}`
      : `-project ${shellQuote(project as string)}`;
    // Capture xcodebuild's combined output to a log file AND stream it to
    // the terminal. On failure we re-print the last lines so the user sees
    // the actual compile error in the error message, not just the command
    // line that failed. `set -o pipefail` ensures xcodebuild's non-zero
    // exit still bubbles out of the pipeline.
    const xcodebuildLog = join(outputDir, 'xcodebuild.log');
    try {
      execSync(
        `set -o pipefail; xcodebuild ${projectArg} -scheme ${shellQuote(scheme)} -configuration Release -sdk iphonesimulator -derivedDataPath ${shellQuote(derivedDataPath)} CODE_SIGNING_ALLOWED=NO build 2>&1 | tee ${shellQuote(xcodebuildLog)}`,
        { stdio: 'inherit', shell: '/bin/bash', env: buildEnv.env } as any,
      );
    } catch (err: any) {
      let tail = '';
      try {
        const full = readFileSync(xcodebuildLog, 'utf-8');
        const lines = full.split('\n');
        // Prefer lines that look like real errors; fall back to last ~60.
        const failureLines = lines.filter((line) =>
          /error:|The following build commands failed|\*\* BUILD FAILED \*\*/.test(line),
        );
        const relevant = failureLines.length > 0 ? failureLines.slice(-15) : lines.slice(-60);
        tail = relevant.join('\n');
      } catch {}
      throw new Error(
        `xcodebuild failed (log: ${xcodebuildLog}).\n` +
          (tail ? `\nLast relevant output:\n${tail}\n` : ''),
      );
    }

    const appPath = findBuiltIOSApp(derivedDataPath);
    if (!appPath) {
      throw new Error('iOS build succeeded, but no Release-iphonesimulator .app was found.');
    }

    const zipPath = join(outputDir, `${safeArtifactName(scheme)}-ios-simulator.app.zip`);
    execSync(`ditto -c -k --sequesterRsrc --keepParent ${shellQuote(appPath)} ${shellQuote(zipPath)}`, {
      stdio: 'inherit',
      env: buildEnv.env,
    });
    return { path: zipPath, kind: 'ios-simulator-app-zip' };
  }

  const gradlew = join(process.cwd(), 'android', 'gradlew');
  // Windows uses gradlew.bat; POSIX uses ./gradlew
  const gradleExecutable = existsSync(gradlew)
    ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
    : 'gradle';
  const androidDir = join(process.cwd(), 'android');
  execSync(`${gradleExecutable} assembleRelease`, {
    cwd: androidDir,
    stdio: 'inherit',
    env: buildEnv.env,
  });

  const apkPath = join(process.cwd(), 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!existsSync(apkPath)) {
    throw new Error('Android build succeeded, but app-release.apk was not found.');
  }
  return { path: apkPath, kind: 'android-apk' };
}

export type DistributionArtifactKind = 'ios-ipa' | 'android-aab' | 'android-apk';

export interface DistributionArtifact {
  path: string;
  kind: DistributionArtifactKind;
}

export interface DistributionOptions {
  outputDir: string;
  /** iOS export method: app-store, ad-hoc, development, enterprise. Default: app-store. */
  iosExportMethod?: 'app-store' | 'ad-hoc' | 'development' | 'enterprise';
  /** Path to an ExportOptions.plist. When omitted we generate one. */
  iosExportOptionsPlist?: string;
  /** iOS development team ID (e.g. ABC1234XYZ). Required when generating the plist. */
  iosTeamId?: string;
  /** Android output format: aab (Play Store) or apk (sideload). Default: aab. */
  androidFormat?: 'aab' | 'apk';
}

/**
 * Build a **distribution-grade** native binary — the one your users actually
 * install from the store.
 *
 * - iOS: `xcodebuild archive` → `xcodebuild -exportArchive` with an
 *   ExportOptions.plist. Produces a signed `.ipa` ready for App Store Connect
 *   / TestFlight upload (via Transporter, altool, or fastlane).
 * - Android: `./gradlew bundleRelease` → signed `.aab` ready for Play Console
 *   (or `assembleRelease` → signed `.apk` with `--android-format apk`).
 *
 * Signing must already be configured in the project (automatic signing + a
 * team id for iOS, `signingConfigs { release { … } }` in build.gradle for
 * Android). This command does NOT embed or generate certificates.
 */
export function buildDistributionArtifact(
  platform: Platform,
  opts: DistributionOptions,
): DistributionArtifact {
  mkdirSync(opts.outputDir, { recursive: true });

  if (platform === 'ios') {
    return buildDistributionIPA(opts);
  }
  return buildDistributionAndroid(opts);
}

function buildDistributionIPA(opts: DistributionOptions): DistributionArtifact {
  const buildEnv = resolveBuildEnv('ios', { strict: true });
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chalk = require('chalk');
    logBuildEnv(buildEnv, chalk.default || chalk);
  } catch { /* ignore */ }

  const workspace = findXcodeWorkspace();
  const project = workspace ? null : findXcodeProject();
  const scheme = findXcodeScheme();
  if (!workspace && !project) {
    throw new Error('No .xcworkspace or .xcodeproj under ios/. Run `expo prebuild` or `pod install` first.');
  }
  if (!scheme) {
    throw new Error('Could not detect an iOS scheme to archive.');
  }

  const archivePath = join(opts.outputDir, `${safeArtifactName(scheme)}.xcarchive`);
  const exportDir = join(opts.outputDir, 'ipa-export');
  if (existsSync(archivePath)) {
    rmSync(archivePath, { recursive: true, force: true });
  }
  if (existsSync(exportDir)) {
    rmSync(exportDir, { recursive: true, force: true });
  }

  const projectArg = workspace
    ? `-workspace ${shellQuote(workspace)}`
    : `-project ${shellQuote(project as string)}`;

  // 1. Archive
  const archiveLog = join(opts.outputDir, 'xcodebuild-archive.log');
  try {
    execSync(
      `set -o pipefail; xcodebuild ${projectArg} -scheme ${shellQuote(scheme)} -configuration Release -destination 'generic/platform=iOS' -archivePath ${shellQuote(archivePath)} archive 2>&1 | tee ${shellQuote(archiveLog)}`,
      { stdio: 'inherit', shell: '/bin/bash', env: buildEnv.env } as any,
    );
  } catch (err: any) {
    throw new Error(
      `xcodebuild archive failed (log: ${archiveLog}). ` +
        `Ensure automatic signing is enabled in Xcode and your Apple Developer team is signed into Xcode, ` +
        `or pass --ios-export-options-plist pointing at a valid ExportOptions.plist.`,
    );
  }

  // 2. Resolve ExportOptions.plist
  let exportOptionsPlist = opts.iosExportOptionsPlist;
  if (!exportOptionsPlist) {
    const teamId = opts.iosTeamId || detectIOSTeamId(archivePath);
    if (!teamId) {
      throw new Error(
        'Could not detect an iOS development team. Pass --ios-team-id <TEAMID>, ' +
          'or provide --ios-export-options-plist <path-to-ExportOptions.plist>.',
      );
    }
    exportOptionsPlist = writeGeneratedExportOptionsPlist(opts.outputDir, {
      method: opts.iosExportMethod || 'app-store',
      teamId,
    });
  }

  // 3. Export archive → .ipa
  const exportLog = join(opts.outputDir, 'xcodebuild-export.log');
  try {
    execSync(
      `set -o pipefail; xcodebuild -exportArchive -archivePath ${shellQuote(archivePath)} -exportPath ${shellQuote(exportDir)} -exportOptionsPlist ${shellQuote(exportOptionsPlist)} 2>&1 | tee ${shellQuote(exportLog)}`,
      { stdio: 'inherit', shell: '/bin/bash', env: buildEnv.env } as any,
    );
  } catch (err: any) {
    throw new Error(
      `xcodebuild -exportArchive failed (log: ${exportLog}). ` +
        `Most common cause: missing or mismatched provisioning profile for the export method.`,
    );
  }

  const ipa = findFirstPath(exportDir, (p) => p.endsWith('.ipa'));
  if (!ipa) {
    throw new Error(`Export succeeded but no .ipa was produced in ${exportDir}`);
  }
  return { path: ipa, kind: 'ios-ipa' };
}

function buildDistributionAndroid(opts: DistributionOptions): DistributionArtifact {
  const buildEnv = resolveBuildEnv('android', { strict: true });
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chalk = require('chalk');
    logBuildEnv(buildEnv, chalk.default || chalk);
  } catch { /* ignore */ }

  const androidDir = join(process.cwd(), 'android');
  if (!existsSync(androidDir)) {
    throw new Error(`No android/ directory at ${process.cwd()}. Run \`expo prebuild\` first.`);
  }
  const gradlew = join(androidDir, 'gradlew');
  const gradleExecutable = existsSync(gradlew)
    ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
    : 'gradle';
  const format = opts.androidFormat || 'aab';
  const task = format === 'aab' ? 'bundleRelease' : 'assembleRelease';

  execSync(`${gradleExecutable} ${task}`, { cwd: androidDir, stdio: 'inherit', env: buildEnv.env });

  const outputsDir = join(androidDir, 'app', 'build', 'outputs');
  const artifactPath =
    format === 'aab'
      ? join(outputsDir, 'bundle', 'release', 'app-release.aab')
      : join(outputsDir, 'apk', 'release', 'app-release.apk');

  if (!existsSync(artifactPath)) {
    throw new Error(
      `Gradle ${task} succeeded but ${artifactPath} is missing. ` +
        `Check your signing config — Play Store uploads require a signed ${format.toUpperCase()}.`,
    );
  }
  return { path: artifactPath, kind: format === 'aab' ? 'android-aab' : 'android-apk' };
}

function detectIOSTeamId(archivePath: string): string | null {
  const infoPlist = join(archivePath, 'Info.plist');
  if (!existsSync(infoPlist)) return null;
  try {
    const out = execSync(
      `/usr/libexec/PlistBuddy -c "Print :ApplicationProperties:Team" ${shellQuote(infoPlist)}`,
      { encoding: 'utf-8' },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function writeGeneratedExportOptionsPlist(
  outputDir: string,
  opts: { method: 'app-store' | 'ad-hoc' | 'development' | 'enterprise'; teamId: string },
): string {
  const path = join(outputDir, 'ExportOptions.generated.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${opts.method}</string>
  <key>teamID</key>
  <string>${opts.teamId}</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>uploadSymbols</key>
  <true/>
  <key>compileBitcode</key>
  <false/>
</dict>
</plist>
`;
  writeFileSync(path, plist);
  return path;
}

function safeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'app';
}

export function installAndLaunchNativePreview(
  platform: Platform,
  opts: {
    appId: string;
    binary?: string;
    device?: string;
  },
): void {
  const appId = opts.appId;
  const binary = opts.binary;

  if (platform === 'ios') {
    const device = opts.device || 'booted';

    if (binary) {
      execSync(`xcrun simctl install ${shellQuote(device)} ${shellQuote(binary)}`, { stdio: 'inherit' });
    }
    execSync(`xcrun simctl launch ${shellQuote(device)} ${shellQuote(appId)}`, { stdio: 'inherit' });
    return;
  }

  // Auto-detect Android SDK so adb gets prepended to PATH even if the
  // user hasn't exported ANDROID_HOME in their shell.
  const androidEnv = resolveBuildEnv('android', { strict: true });
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chalk = require('chalk');
    logBuildEnv(androidEnv, chalk.default || chalk);
  } catch { /* ignore */ }

  const deviceArg = opts.device ? `-s ${shellQuote(opts.device)} ` : '';
  if (binary) {
    execSync(`adb ${deviceArg}install -r ${shellQuote(binary)}`, { stdio: 'inherit', env: androidEnv.env });
  }
  execSync(`adb ${deviceArg}shell monkey -p ${shellQuote(appId)} -c android.intent.category.LAUNCHER 1`, { stdio: 'inherit', env: androidEnv.env });
}

export function installAndLaunchNativePreviewArtifact(
  platform: Platform,
  opts: {
    appId: string;
    artifactPath: string;
    artifactKind: string;
    /**
     * Extracted OTA stage directory containing `bundle.jsbundle` + `assets/`.
     * When provided, the entire directory is copied into the simulator's
     * data container so the patched bundle's asset paths resolve correctly.
     */
    previewStageDir?: string;
    previewLabel?: string;
    clearDeployState?: boolean;
    device?: string;
    /**
     * When true, after launch the CLI attaches to the running process and
     * streams its stdout/stderr to the terminal (via `simctl --console-pty`
     * on iOS, `adb logcat` on Android). Ctrl+C detaches without killing
     * the app.
     */
    streamLogs?: boolean;
  },
): void {
  if (platform === 'ios') {
    if (opts.artifactKind !== 'ios-simulator-app-zip') {
      throw new Error(`Unsupported iOS preview artifact kind: ${opts.artifactKind || 'missing'}`);
    }
    const extractDir = join(dirname(opts.artifactPath), `${basename(opts.artifactPath).replace(/[^A-Za-z0-9._-]/g, '_')}.unzipped`);
    if (existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
    mkdirSync(extractDir, { recursive: true });
    execSync(`ditto -x -k ${shellQuote(opts.artifactPath)} ${shellQuote(extractDir)}`, { stdio: 'inherit' });
    const appPath = findAppInDirectory(extractDir);
    if (!appPath) {
      throw new Error('Downloaded iOS preview artifact did not contain a .app bundle.');
    }

    // For patches, replace every embedded .jsbundle inside the .app with the
    // patch's bundle. Belt-and-suspenders: even if the AppDelegate hook fails
    // to read sankofa_deploy_bundle_path, the .app's own main.jsbundle now IS
    // the patch. Assets stay in the .app — RN's resolver looks there too as
    // a fallback for any asset not present alongside the OTA bundle.
    if (opts.previewStageDir) {
      const stagedBundle = join(opts.previewStageDir, 'bundle.jsbundle');
      if (!existsSync(stagedBundle)) {
        throw new Error(`Preview stage dir missing bundle.jsbundle: ${opts.previewStageDir}`);
      }
      const embedded = collectJSBundles(appPath);
      const targets = embedded.length > 0 ? embedded : [join(appPath, 'main.jsbundle')];
      for (const target of targets) {
        copyFileSync(stagedBundle, target);
      }
    }

    const device = opts.device || 'booted';
    // Uninstall first so the simulator never reuses a cached binary or stale
    // embedded JS bundle from a previous preview run.
    try {
      execSync(`xcrun simctl uninstall ${shellQuote(device)} ${shellQuote(opts.appId)}`, { stdio: 'ignore' });
    } catch {}
    execSync(`xcrun simctl install ${shellQuote(device)} ${shellQuote(appPath)}`, { stdio: 'inherit' });
    if (opts.previewStageDir && opts.previewLabel) {
      // Patch preview: copy the whole staged dir (bundle + assets) into the
      // app's data container and point sankofa_deploy_bundle_path at the
      // bundle inside it. RN's AssetSourceResolver resolves assets relative
      // to the bundle URL's directory, so fonts/images load correctly.
      seedIOSPreviewStage(device, opts.appId, opts.previewStageDir, opts.previewLabel);
    } else if (opts.previewLabel) {
      // Base preview: seed only the label so the SDK's next update check
      // sends `current_bundle_label=<base>`. Without this the server returns
      // the same base release as an "available update" and the SDK downloads
      // it needlessly. The embedded .app bundle provides the JS.
      seedIOSBaseLabel(device, opts.appId, opts.previewLabel);
    } else if (opts.clearDeployState) {
      clearIOSDeployState(device, opts.appId);
    }
    if (opts.streamLogs) {
      // --console-pty launches AND streams the app's stdout/stderr (including
      // RN's console.log) to the terminal. Ctrl+C detaches without killing
      // the app. Blocks until the user exits.
      console.log(`\n  Streaming logs for ${opts.appId}. Ctrl+C to detach.\n`);
      execSync(
        `xcrun simctl launch --console-pty ${shellQuote(device)} ${shellQuote(opts.appId)}`,
        { stdio: 'inherit' },
      );
    } else {
      execSync(
        `xcrun simctl launch ${shellQuote(device)} ${shellQuote(opts.appId)}`,
        { stdio: 'inherit' },
      );
    }
    return;
  }

  if (opts.artifactKind !== 'android-apk') {
    throw new Error(`Unsupported Android preview artifact kind: ${opts.artifactKind || 'missing'}`);
  }
  installAndLaunchNativePreview(platform, {
    appId: opts.appId,
    binary: opts.artifactPath,
    device: opts.device,
  });

  if (opts.streamLogs) {
    const deviceArg = opts.device ? `-s ${shellQuote(opts.device)} ` : '';
    // Reuse the same Android env (adb injected onto PATH) as the install step.
    const androidEnv = resolveBuildEnv('android');
    // Clear the buffer so we only show logs for this session, then tail
    // everything with priority Info or higher from the app's process. Ctrl+C
    // exits logcat without killing the app.
    try {
      execSync(`adb ${deviceArg}logcat -c`, { stdio: 'ignore', env: androidEnv.env });
    } catch {}
    console.log(`\n  Streaming logs for ${opts.appId}. Ctrl+C to detach.\n`);
    execSync(
      `adb ${deviceArg}logcat --pid=$(adb ${deviceArg}shell pidof -s ${shellQuote(opts.appId)}) *:I`,
      { stdio: 'inherit', shell: '/bin/bash', env: androidEnv.env } as any,
    );
  }
}

function deleteIOSDefault(device: string, appId: string, key: string): void {
  try {
    execSync(`xcrun simctl spawn ${shellQuote(device)} defaults delete ${shellQuote(appId)} ${shellQuote(key)}`, { stdio: 'ignore' });
  } catch {}
}

function clearIOSDeployState(device: string, appId: string): void {
  for (const key of [
    'sankofa_deploy_bundle_path',
    'sankofa:deploy:current_label',
    'sankofa:deploy:current_bundle_path',
    'sankofa:deploy:previous_label',
    'sankofa:deploy:previous_bundle_path',
    'sankofa:deploy:pending_label',
    'sankofa:deploy:pending_bundle_path',
    'sankofa:deploy:rolled_back_label',
    'sankofa:deploy:crash_count',
    'sankofa:deploy:last_boot_time',
    'sankofa:deploy:boot_confirmed',
  ]) {
    deleteIOSDefault(device, appId, key);
  }
}

/**
 * Seed an extracted OTA stage directory (bundle + assets) into the simulator's
 * data container so the patched bundle's asset paths resolve correctly. The
 * staged dir is placed at:
 *
 *   <data>/Library/Application Support/SankofaDeployPreview/<safe-label>/
 *     bundle.jsbundle
 *     assets/…
 *
 * `sankofa_deploy_bundle_path` is pointed at `bundle.jsbundle`, and RN's
 * AssetSourceResolver finds `assets/…` next to it (file:// scriptURL → assets
 * resolve relative to the bundle's directory).
 */
function seedIOSPreviewStage(device: string, appId: string, stageDir: string, label: string): void {
  clearIOSDeployState(device, appId);

  const dataContainer = execSync(
    `xcrun simctl get_app_container ${shellQuote(device)} ${shellQuote(appId)} data`,
    { encoding: 'utf-8' },
  ).trim();
  if (!dataContainer) {
    throw new Error(`Could not resolve iOS simulator data container for ${appId}`);
  }

  const previewRoot = join(dataContainer, 'Library', 'Application Support', 'SankofaDeployPreview');
  mkdirSync(previewRoot, { recursive: true });
  const seededDir = join(previewRoot, safeArtifactName(label));
  if (existsSync(seededDir)) {
    rmSync(seededDir, { recursive: true, force: true });
  }
  mkdirSync(seededDir, { recursive: true });
  // Copy the entire stage dir contents (bundle + assets/) into the seeded dir.
  execSync(`cp -R ${shellQuote(stageDir)}/. ${shellQuote(seededDir)}/`, { stdio: 'inherit' });

  const seededBundlePath = join(seededDir, 'bundle.jsbundle');
  if (!existsSync(seededBundlePath)) {
    throw new Error(`Seeded preview dir missing bundle.jsbundle: ${seededDir}`);
  }

  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} sankofa_deploy_bundle_path -string ${shellQuote(seededBundlePath)}`);
  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} 'sankofa:deploy:current_label' -string ${shellQuote(label)}`);
  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} 'sankofa:deploy:current_bundle_path' -string ${shellQuote(seededBundlePath)}`);
  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} 'sankofa:deploy:boot_confirmed' -string true`);
}

function seedIOSBaseLabel(device: string, appId: string, label: string): void {
  clearIOSDeployState(device, appId);
  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} 'sankofa:deploy:current_label' -string ${shellQuote(label)}`);
  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} 'sankofa:deploy:boot_confirmed' -string true`);
}

/**
 * Build the native binary (IPA/AAB/APK).
 * Returns the path to the built artifact.
 */
export function buildNative(
  platform: Platform,
  outputDir: string,
  outputFormat?: string, // 'apk' for Android (default: 'aab')
): string {
  const buildEnv = resolveBuildEnv(platform as TargetPlatform, { strict: true });
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chalk = require('chalk');
    logBuildEnv(buildEnv, chalk.default || chalk);
  } catch { /* ignore */ }

  const isExpo = existsSync(join(process.cwd(), 'node_modules', 'expo'));

  if (platform === 'ios') {
    if (isExpo) {
      execSync(`npx expo run:ios --configuration Release`, { stdio: 'inherit', env: buildEnv.env });
    } else {
      execSync(
        `cd ios && xcodebuild -workspace *.xcworkspace -scheme * -configuration Release -archivePath ${outputDir}/app.xcarchive archive`,
        { stdio: 'inherit', env: buildEnv.env },
      );
    }
    return join(outputDir, 'app.ipa');
  } else {
    const task = outputFormat === 'apk' ? 'assembleRelease' : 'bundleRelease';
    const androidDir = join(process.cwd(), 'android');
    const gradleExecutable = existsSync(join(androidDir, 'gradlew'))
      ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
      : 'gradle';
    execSync(`${gradleExecutable} ${task}`, { cwd: androidDir, stdio: 'inherit', env: buildEnv.env });

    const ext = outputFormat === 'apk' ? 'apk' : 'aab';
    const defaultPath = join(
      process.cwd(),
      'android',
      'app',
      'build',
      'outputs',
      outputFormat === 'apk' ? 'apk' : 'bundle',
      'release',
      `app-release.${ext}`,
    );
    return defaultPath;
  }
}

/** Compute SHA256 hash of a file */
export function computeSHA256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** Get file size in bytes */
export function getFileSize(filePath: string): number {
  return statSync(filePath).size;
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
