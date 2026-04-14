import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createHash } from 'crypto';

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
export function detectAppVersion(platform: Platform): string | null {
  // 1. Expo: app.json or app.config.js
  const appJsonPath = join(process.cwd(), 'app.json');
  if (existsSync(appJsonPath)) {
    try {
      const appJson = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
      const version = appJson.expo?.version || appJson.version;
      if (version) return version;
    } catch {}
  }

  // 2. iOS: Info.plist
  if (platform === 'ios') {
    try {
      const plistOutput = execSync(
        `find ios -name Info.plist -not -path "*/Pods/*" -not -path "*/build/*" | head -1`,
        { encoding: 'utf-8' },
      ).trim();
      if (plistOutput) {
        const version = execSync(
          `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${plistOutput}"`,
          { encoding: 'utf-8' },
        ).trim();
        if (version) return version;
      }
    } catch {}
  }

  // 3. Android: build.gradle
  if (platform === 'android') {
    const gradlePath = join(process.cwd(), 'android', 'app', 'build.gradle');
    if (existsSync(gradlePath)) {
      const content = readFileSync(gradlePath, 'utf-8');
      const match = content.match(/versionName\s+["'](.+?)["']/);
      if (match) return match[1];
    }
    // Also check build.gradle.kts
    const gradleKtsPath = join(process.cwd(), 'android', 'app', 'build.gradle.kts');
    if (existsSync(gradleKtsPath)) {
      const content = readFileSync(gradleKtsPath, 'utf-8');
      const match = content.match(/versionName\s*=\s*["'](.+?)["']/);
      if (match) return match[1];
    }
  }

  return null;
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
 * Bundle the JS using Metro (React Native's bundler).
 * Works for both Expo and bare RN projects.
 *
 * Uses `npx --no-install` so we fail loudly if the bundler is missing from the
 * project, instead of letting npx auto-install `react-native` into the current
 * working directory.
 */
export function bundleJS(
  platform: Platform,
  entryFile: string,
  outputPath: string,
): void {
  const isExpo = projectUsesExpo();
  const cli = isExpo ? 'expo export:embed' : 'react-native bundle';
  try {
    execSync(
      `npx --no-install ${cli} --platform ${platform} --entry-file ${entryFile} --bundle-output ${outputPath} --dev false`,
      { stdio: 'inherit' },
    );
  } catch (err: any) {
    const tool = isExpo ? 'expo' : 'react-native';
    throw new Error(
      `${tool} bundler is not available in ${process.cwd()}. ` +
        `Install project dependencies (e.g. \`npm install\`) in the React Native app directory before running this command.`,
    );
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
 * Build an installable native preview artifact without installing or launching.
 * The artifact is uploaded with a Deploy release so `sankofa preview` can install
 * exactly what was published, not rebuild the local source tree.
 */
export function buildNativePreviewArtifact(
  platform: Platform,
  outputDir: string,
): NativePreviewArtifact {
  mkdirSync(outputDir, { recursive: true });

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

    const derivedDataPath = join(outputDir, 'sankofa-ios-preview-derived-data');
    const projectArg = workspace
      ? `-workspace ${shellQuote(workspace)}`
      : `-project ${shellQuote(project as string)}`;
    execSync(
      `xcodebuild ${projectArg} -scheme ${shellQuote(scheme)} -configuration Release -sdk iphonesimulator -derivedDataPath ${shellQuote(derivedDataPath)} CODE_SIGNING_ALLOWED=NO build`,
      { stdio: 'inherit' },
    );

    const appPath = findBuiltIOSApp(derivedDataPath);
    if (!appPath) {
      throw new Error('iOS build succeeded, but no Release-iphonesimulator .app was found.');
    }

    const zipPath = join(outputDir, `${safeArtifactName(scheme)}-ios-simulator.app.zip`);
    execSync(`ditto -c -k --sequesterRsrc --keepParent ${shellQuote(appPath)} ${shellQuote(zipPath)}`, {
      stdio: 'inherit',
    });
    return { path: zipPath, kind: 'ios-simulator-app-zip' };
  }

  const gradlew = join(process.cwd(), 'android', 'gradlew');
  const gradleExecutable = existsSync(gradlew) ? './gradlew' : 'gradle';
  execSync(`${gradleExecutable} assembleRelease`, {
    cwd: join(process.cwd(), 'android'),
    stdio: 'inherit',
  });

  const apkPath = join(process.cwd(), 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!existsSync(apkPath)) {
    throw new Error('Android build succeeded, but app-release.apk was not found.');
  }
  return { path: apkPath, kind: 'android-apk' };
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

  const deviceArg = opts.device ? `-s ${shellQuote(opts.device)} ` : '';
  if (binary) {
    execSync(`adb ${deviceArg}install -r ${shellQuote(binary)}`, { stdio: 'inherit' });
  }
  execSync(`adb ${deviceArg}shell monkey -p ${shellQuote(appId)} -c android.intent.category.LAUNCHER 1`, { stdio: 'inherit' });
}

export function installAndLaunchNativePreviewArtifact(
  platform: Platform,
  opts: {
    appId: string;
    artifactPath: string;
    artifactKind: string;
    previewBundlePath?: string;
    previewLabel?: string;
    clearDeployState?: boolean;
    device?: string;
  },
): void {
  if (platform === 'ios') {
    if (opts.artifactKind !== 'ios-simulator-app-zip') {
      throw new Error(`Unsupported iOS preview artifact kind: ${opts.artifactKind || 'missing'}`);
    }
    const extractDir = join(dirname(opts.artifactPath), `${basename(opts.artifactPath).replace(/[^A-Za-z0-9._-]/g, '_')}.unzipped`);
    mkdirSync(extractDir, { recursive: true });
    execSync(`ditto -x -k ${shellQuote(opts.artifactPath)} ${shellQuote(extractDir)}`, { stdio: 'inherit' });
    const appPath = findAppInDirectory(extractDir);
    if (!appPath) {
      throw new Error('Downloaded iOS preview artifact did not contain a .app bundle.');
    }
    const device = opts.device || 'booted';
    execSync(`xcrun simctl install ${shellQuote(device)} ${shellQuote(appPath)}`, { stdio: 'inherit' });
    if (opts.previewBundlePath && opts.previewLabel) {
      seedIOSPreviewBundle(device, opts.appId, opts.previewBundlePath, opts.previewLabel);
    } else if (opts.clearDeployState) {
      clearIOSDeployState(device, opts.appId);
    }
    execSync(`xcrun simctl launch ${shellQuote(device)} ${shellQuote(opts.appId)}`, { stdio: 'inherit' });
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

function seedIOSPreviewBundle(device: string, appId: string, bundlePath: string, label: string): void {
  clearIOSDeployState(device, appId);

  const dataContainer = execSync(
    `xcrun simctl get_app_container ${shellQuote(device)} ${shellQuote(appId)} data`,
    { encoding: 'utf-8' },
  ).trim();
  if (!dataContainer) {
    throw new Error(`Could not resolve iOS simulator data container for ${appId}`);
  }

  const previewDir = join(dataContainer, 'Library', 'Application Support', 'SankofaDeployPreview');
  mkdirSync(previewDir, { recursive: true });
  const seededBundlePath = join(previewDir, `${safeArtifactName(label)}.jsbundle`);
  copyFileSync(bundlePath, seededBundlePath);

  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} sankofa_deploy_bundle_path -string ${shellQuote(seededBundlePath)}`);
  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} 'sankofa:deploy:current_label' -string ${shellQuote(label)}`);
  execSync(`xcrun simctl spawn ${shellQuote(device)} defaults write ${shellQuote(appId)} 'sankofa:deploy:current_bundle_path' -string ${shellQuote(seededBundlePath)}`);
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
  const isExpo = existsSync(join(process.cwd(), 'node_modules', 'expo'));

  if (platform === 'ios') {
    if (isExpo) {
      execSync(`npx expo run:ios --configuration Release`, { stdio: 'inherit' });
    } else {
      execSync(
        `cd ios && xcodebuild -workspace *.xcworkspace -scheme * -configuration Release -archivePath ${outputDir}/app.xcarchive archive`,
        { stdio: 'inherit' },
      );
    }
    return join(outputDir, 'app.ipa');
  } else {
    const task = outputFormat === 'apk' ? 'assembleRelease' : 'bundleRelease';
    execSync(`cd android && ./gradlew ${task}`, { stdio: 'inherit' });

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
