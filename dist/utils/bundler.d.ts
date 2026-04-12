export type Platform = 'ios' | 'android';
/**
 * Detect the native app version from the project files.
 *
 * Priority:
 * 1. app.json - expo.version (Expo projects)
 * 2. ios/Info.plist - CFBundleShortVersionString
 * 3. android/app/build.gradle - versionName
 */
export declare function detectAppVersion(platform: Platform): string | null;
/**
 * Bundle the JS using Metro (React Native's bundler).
 * Works for both Expo and bare RN projects.
 */
export declare function bundleJS(platform: Platform, entryFile: string, outputPath: string): void;
/**
 * Build the native binary (IPA/AAB/APK).
 * Returns the path to the built artifact.
 */
export declare function buildNative(platform: Platform, outputDir: string, outputFormat?: string): string;
/** Compute SHA256 hash of a file */
export declare function computeSHA256(filePath: string): string;
/** Get file size in bytes */
export declare function getFileSize(filePath: string): number;
/** Format bytes to human-readable string */
export declare function formatBytes(bytes: number): string;
