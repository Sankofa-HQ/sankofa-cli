import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { hashFlutterAssetsTree } from './flutterBundler.js';
import { baselineDir, hasBaseline, readBaselineManifest } from './baseline.js';

/**
 * Diff Guard — implements the safety net documented in
 * `compliance-posture.md` §5. Compares the developer's current build
 * against the baseline (captured by `sankofa release`) and refuses
 * publishes that would change anything outside the OTA-eligible scope.
 *
 * Outcomes are split into:
 *  - refusals: hard blockers. Patch MUST NOT ship.
 *  - warnings: soft signals. Patch ships with a heads-up.
 *
 * Caller is expected to render both before deciding whether to upload.
 */

export interface DiffGuardOutcome {
  refusals: DiffGuardFinding[];
  warnings: DiffGuardFinding[];
}

export interface DiffGuardFinding {
  /** Short label, e.g. "AndroidManifest.xml". */
  label: string;
  /** Multi-line human explanation, including the actual change when known. */
  detail: string;
  /** What the dev should do to resolve. */
  remedy: string;
}

export interface FlutterDiffGuardInput {
  projectRoot: string;
  /**
   * Path to the directory containing the freshly-built APK's
   * `AndroidManifest.xml` and `assets/flutter_assets/` tree. Produced by
   * `buildFlutterAOT()` and returned as `apkContentsDir`.
   */
  apkContentsDir: string;
}

export function runFlutterDiffGuard(input: FlutterDiffGuardInput): DiffGuardOutcome {
  const refusals: DiffGuardFinding[] = [];
  const warnings: DiffGuardFinding[] = [];
  const dir = baselineDir(input.projectRoot);

  if (!hasBaseline(input.projectRoot)) {
    refusals.push({
      label: 'No baseline on disk',
      detail:
        '`.sankofa/baseline/` is missing. Diff Guard needs a baseline captured by ' +
        '`sankofa release` to compare against.',
      remedy: 'Run `sankofa release` first to capture the baseline, then re-run `sankofa patch`.',
    });
    return { refusals, warnings };
  }

  const manifest = readBaselineManifest(input.projectRoot);
  if (!manifest) {
    refusals.push({
      label: 'Baseline manifest unreadable',
      detail: 'Could not parse `.sankofa/baseline/manifest.json`.',
      remedy: 'Re-run `sankofa release` to regenerate the baseline.',
    });
    return { refusals, warnings };
  }

  // 1. AndroidManifest.xml byte-identical check.
  const baselineManifestPath = join(dir, 'AndroidManifest.xml');
  const currentManifestPath = join(input.apkContentsDir, 'AndroidManifest.xml');
  const manifestFinding = compareBytes(
    'AndroidManifest.xml',
    baselineManifestPath,
    currentManifestPath,
    'Changes to AndroidManifest require a new store release.',
  );
  if (manifestFinding) refusals.push(manifestFinding);

  // 2. flutter_assets/ tree hash check.
  const currentAssetsDir = join(input.apkContentsDir, 'assets', 'flutter_assets');
  const baselineAssetsHashPath = join(dir, 'flutter_assets.sha256.json');
  const assetFindings = compareFlutterAssets(baselineAssetsHashPath, currentAssetsDir);
  refusals.push(...assetFindings);

  // 3. pubspec.lock plugin diff — soft warning.
  const pubspecLockFinding = comparePubspecLock(input.projectRoot, dir);
  if (pubspecLockFinding) warnings.push(pubspecLockFinding);

  return { refusals, warnings };
}

function compareBytes(
  label: string,
  baselinePath: string,
  currentPath: string,
  whatHappensIfDifferent: string,
): DiffGuardFinding | null {
  if (!existsSync(baselinePath)) {
    return {
      label,
      detail: `Baseline copy of ${label} is missing at ${baselinePath}.`,
      remedy: 'Re-run `sankofa release` to capture a fresh baseline.',
    };
  }
  if (!existsSync(currentPath)) {
    return {
      label,
      detail: `Current build does not include ${label} at ${currentPath}. This usually means the APK extraction failed.`,
      remedy: 'Re-run the build; if the problem persists, check that the APK includes the expected files.',
    };
  }
  const a = readFileSync(baselinePath);
  const b = readFileSync(currentPath);
  if (a.equals(b)) return null;
  return {
    label,
    detail: `${label} differs from the baseline (${a.length} → ${b.length} bytes). ${whatHappensIfDifferent}`,
    remedy: 'Revert the change, or run `sankofa release` to ship a new store binary that includes the change.',
  };
}

function compareFlutterAssets(
  baselineHashPath: string,
  currentAssetsDir: string,
): DiffGuardFinding[] {
  const findings: DiffGuardFinding[] = [];

  if (!existsSync(baselineHashPath)) {
    findings.push({
      label: 'flutter_assets baseline',
      detail: `Baseline hash file missing at ${baselineHashPath}.`,
      remedy: 'Re-run `sankofa release` to capture a fresh baseline.',
    });
    return findings;
  }

  let baselineHashes: Record<string, string>;
  try {
    baselineHashes = JSON.parse(readFileSync(baselineHashPath, 'utf-8'));
  } catch {
    findings.push({
      label: 'flutter_assets baseline',
      detail: `Could not parse ${baselineHashPath}.`,
      remedy: 'Re-run `sankofa release` to regenerate the baseline.',
    });
    return findings;
  }

  const currentHashes = hashFlutterAssetsTree(currentAssetsDir);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const path of Object.keys(currentHashes)) {
    if (!(path in baselineHashes)) {
      added.push(path);
    } else if (currentHashes[path] !== baselineHashes[path]) {
      changed.push(path);
    }
  }
  for (const path of Object.keys(baselineHashes)) {
    if (!(path in currentHashes)) {
      removed.push(path);
    }
  }

  if (added.length + removed.length + changed.length === 0) {
    return findings;
  }

  const lines: string[] = [];
  if (added.length > 0) lines.push(`  Added (${added.length}):    ${preview(added)}`);
  if (changed.length > 0) lines.push(`  Changed (${changed.length}): ${preview(changed)}`);
  if (removed.length > 0) lines.push(`  Removed (${removed.length}): ${preview(removed)}`);

  findings.push({
    label: 'flutter_assets/ tree',
    detail:
      'flutter_assets/ has changed since the baseline. The OTA patch only ships libapp.so — ' +
      'new or changed assets will NOT reach users.\n' + lines.join('\n'),
    remedy: 'Either revert the asset change, or run `sankofa release` to ship a new store binary that bundles it.',
  });
  return findings;
}

function preview(items: string[]): string {
  const max = 5;
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')}, … (+${items.length - max} more)`;
}

function comparePubspecLock(
  projectRoot: string,
  baselineDirPath: string,
): DiffGuardFinding | null {
  const current = join(projectRoot, 'pubspec.lock');
  const baseline = join(baselineDirPath, 'pubspec.lock');
  if (!existsSync(current)) return null;
  if (!existsSync(baseline)) {
    // Baseline didn't capture pubspec.lock — first-time. Skip.
    return null;
  }
  const a = readFileSync(baseline, 'utf-8');
  const b = readFileSync(current, 'utf-8');
  if (a === b) return null;
  return {
    label: 'pubspec.lock',
    detail:
      'pubspec.lock differs from the baseline. If you added or removed a plugin with native code ' +
      '(platform channels, FFI), the change will NOT reach users via this patch.',
    remedy:
      'If the diff is only pure-Dart packages, ignore. If it includes native plugins, run `sankofa release` instead.',
  };
}
