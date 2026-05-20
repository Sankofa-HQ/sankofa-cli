import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { hashFlutterAssetsTree } from './flutterBundler.js';

/**
 * Per-project Diff Guard baseline.
 *
 * Captured on `sankofa release` (the OTA-eligible state at store-submission
 * time) and used by `sankofa patch` to refuse changes that would silently
 * no-op. The Compliance Posture doc enumerates the full set of checks; this
 * utility is the place where each baseline artifact gets written and
 * later compared.
 */

const BASELINE_DIR = '.sankofa/baseline';

export interface BaselineManifest {
  /** Schema version of this manifest. Bump when the on-disk format changes. */
  version: 1;
  /** Stack the baseline was captured for. */
  stack: 'flutter' | 'react-native';
  /** Sankofa server release label (e.g. "v1.0.0"). */
  releaseLabel: string;
  /** App's binary version at baseline (e.g. "1.0.0"). */
  targetBinaryVersion: string;
  /** Flutter only: Sankofa engine version used to build the baseline. */
  engineVersion?: string;
  /** SHA256 of the baseline libapp.so / OTA archive. */
  payloadSha256: string;
  /** ISO 8601 timestamp of when the baseline was captured. */
  capturedAt: string;
}

export interface FlutterBaselineCaptureOpts {
  projectRoot: string;
  /** Path to the extracted AndroidManifest.xml (from the built APK). */
  androidManifestPath: string;
  /**
   * Path to the extracted `assets/flutter_assets/` directory (from the
   * built APK). Hashed into a JSON map.
   */
  flutterAssetsDir: string;
  manifest: BaselineManifest;
}

export function captureFlutterBaseline(opts: FlutterBaselineCaptureOpts): string {
  const dir = join(opts.projectRoot, BASELINE_DIR);
  mkdirSync(dir, { recursive: true });

  // 1. AndroidManifest.xml — byte-identical copy.
  if (existsSync(opts.androidManifestPath)) {
    copyFileSync(opts.androidManifestPath, join(dir, 'AndroidManifest.xml'));
  }

  // 2. flutter_assets/ → sha256 map.
  const tree = hashFlutterAssetsTree(opts.flutterAssetsDir);
  writeFileSync(
    join(dir, 'flutter_assets.sha256.json'),
    JSON.stringify(tree, null, 2) + '\n',
  );

  // 3. pubspec.lock — soft signal for plugin diff (warning-level).
  const lockPath = join(opts.projectRoot, 'pubspec.lock');
  if (existsSync(lockPath)) {
    copyFileSync(lockPath, join(dir, 'pubspec.lock'));
  }

  // 4. manifest.json — metadata.
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(opts.manifest, null, 2) + '\n',
  );

  return dir;
}

export interface ReactNativeBaselineCaptureOpts {
  projectRoot: string;
  /** Optional: path to AndroidManifest.xml (e.g. from android/app/src/main/). */
  androidManifestPath?: string;
  /** Optional: path to Info.plist (e.g. from ios/Runner/). */
  infoPlistPath?: string;
  manifest: BaselineManifest;
}

export function captureReactNativeBaseline(opts: ReactNativeBaselineCaptureOpts): string {
  const dir = join(opts.projectRoot, BASELINE_DIR);
  mkdirSync(dir, { recursive: true });

  if (opts.androidManifestPath && existsSync(opts.androidManifestPath)) {
    copyFileSync(opts.androidManifestPath, join(dir, 'AndroidManifest.xml'));
  }
  if (opts.infoPlistPath && existsSync(opts.infoPlistPath)) {
    copyFileSync(opts.infoPlistPath, join(dir, 'Info.plist'));
  }

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(opts.manifest, null, 2) + '\n',
  );

  return dir;
}

export function readBaselineManifest(projectRoot: string): BaselineManifest | null {
  const path = join(projectRoot, BASELINE_DIR, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function baselineDir(projectRoot: string): string {
  return join(projectRoot, BASELINE_DIR);
}

export function hasBaseline(projectRoot: string): boolean {
  return existsSync(join(projectRoot, BASELINE_DIR, 'manifest.json'));
}

export function baselineAgeSeconds(projectRoot: string): number | null {
  const path = join(projectRoot, BASELINE_DIR, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    const stats = statSync(path);
    return Math.floor((Date.now() - stats.mtimeMs) / 1000);
  } catch {
    return null;
  }
}
