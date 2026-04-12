import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export type Platform = 'ios' | 'android';

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

/**
 * Bundle the JS using Metro (React Native's bundler).
 * Works for both Expo and bare RN projects.
 */
export function bundleJS(
  platform: Platform,
  entryFile: string,
  outputPath: string,
): void {
  const isExpo = existsSync(join(process.cwd(), 'node_modules', 'expo'));

  if (isExpo) {
    // Expo: use npx expo export:embed
    execSync(
      `npx expo export:embed --platform ${platform} --entry-file ${entryFile} --bundle-output ${outputPath} --dev false`,
      { stdio: 'inherit' },
    );
  } else {
    // Bare RN: use react-native bundle
    execSync(
      `npx react-native bundle --platform ${platform} --entry-file ${entryFile} --bundle-output ${outputPath} --dev false`,
      { stdio: 'inherit' },
    );
  }
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
  return require('fs').statSync(filePath).size;
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
