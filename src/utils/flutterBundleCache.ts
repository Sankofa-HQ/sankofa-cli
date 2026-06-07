import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * # Bundled Flutter SDK cache
 *
 * Sankofa ships a forked Flutter SDK (`Sankofa-HQ/sankofa-flutter`) that
 * contains both the framework and the modified engine sources. Customers
 * never overwrite their own `flutter` install — instead the CLI keeps a
 * second, parallel Flutter SDK at:
 *
 *   ~/.sankofa/flutter/<sankofa_engine_version>/
 *     ├── bin/flutter
 *     ├── bin/cache/
 *     ├── packages/flutter/...
 *     └── ...
 *
 * `sankofa release`, `sankofa patch`, and `sankofa preview` all shell out
 * to this bundled flutter. The customer's `which flutter` continues to
 * point at upstream Flutter for everyday dev (e.g. `flutter run` against
 * an unmodified app).
 *
 * This mirrors Shorebird's `~/.shorebird/bin/cache/flutter/<rev>/` layout
 * and is the same isolation pattern they've shipped in production for years.
 */

export interface BundledFlutterInfo {
  /** Friendly version, e.g. "3.44.0+sankofa-1". */
  sankofaEngineVersion: string;
  /** Absolute path to the bundled flutter root (the SDK directory). */
  root: string;
  /** Absolute path to the bundled `bin/flutter` executable. */
  bin: string;
  /** True iff the bundled SDK exists on disk. */
  exists: boolean;
}

const SANKOFA_FLUTTER_REPO_URL = 'https://github.com/Sankofa-HQ/sankofa-flutter.git';
const DEFAULT_BRANCH = 'phase1/sankofa-codepush-engine-integration';

function sankofaHome(): string {
  return process.env.SANKOFA_HOME || join(homedir(), '.sankofa');
}

export function bundledFlutterRoot(sankofaEngineVersion: string): string {
  return join(sankofaHome(), 'flutter', sankofaEngineVersion);
}

export function bundledFlutterInfo(sankofaEngineVersion: string): BundledFlutterInfo {
  const root = bundledFlutterRoot(sankofaEngineVersion);
  const bin = join(root, 'bin', 'flutter');
  let exists = false;
  try {
    exists = statSync(bin).isFile();
  } catch {
    exists = false;
  }
  return { sankofaEngineVersion, root, bin, exists };
}

export interface InstallBundledFlutterOptions {
  /** Skip re-clone if already present (default true). */
  reuseIfPresent?: boolean;
  /** Override repo URL (e.g. for testing). */
  repoUrl?: string;
  /** Branch or tag or commit to check out. */
  ref?: string;
  /**
   * If set, use this local sankofa-flutter checkout instead of cloning.
   * The CLI symlinks the path so the bundled cache stays a normal location.
   * Used in dev workflows where the engineer is iterating on the engine
   * fork locally (e.g. founder rebuilding the engine on the spot).
   */
  localPath?: string;
  /** Progress reporter (called with one short message per step). */
  onProgress?: (msg: string) => void;
}

/**
 * Install the Sankofa Flutter fork at the requested version into the
 * bundled cache. Returns the resulting BundledFlutterInfo.
 *
 * Resolution order:
 *   1. If opts.localPath is set → symlink that path into the cache.
 *   2. Else if env $SANKOFA_FLUTTER_LOCAL is set → symlink it.
 *   3. Else `git clone` from opts.repoUrl (default Sankofa-HQ/sankofa-flutter).
 */
export function installBundledFlutter(
  sankofaEngineVersion: string,
  opts: InstallBundledFlutterOptions = {},
): BundledFlutterInfo {
  const reuse = opts.reuseIfPresent ?? true;
  const info = bundledFlutterInfo(sankofaEngineVersion);

  if (reuse && info.exists) {
    opts.onProgress?.(`Bundled flutter already present at ${info.root}`);
    return info;
  }

  const root = info.root;
  mkdirSync(join(sankofaHome(), 'flutter'), { recursive: true });

  const localPath = opts.localPath || process.env.SANKOFA_FLUTTER_LOCAL;
  if (localPath) {
    if (!existsSync(localPath)) {
      throw new Error(`SANKOFA_FLUTTER_LOCAL points at missing path: ${localPath}`);
    }
    // Symlink so updates in the local checkout reflect immediately.
    try {
      if (existsSync(root)) {
        execSync(`rm -rf ${shellQuote(root)}`);
      }
      execSync(`ln -s ${shellQuote(localPath)} ${shellQuote(root)}`);
      opts.onProgress?.(`Linked bundled flutter -> ${localPath}`);
    } catch (err: any) {
      throw new Error(`Failed to link bundled flutter from ${localPath}: ${err.message}`);
    }
    return bundledFlutterInfo(sankofaEngineVersion);
  }

  const repoUrl = opts.repoUrl || SANKOFA_FLUTTER_REPO_URL;
  const ref = opts.ref || DEFAULT_BRANCH;
  opts.onProgress?.(`Cloning ${repoUrl} (${ref}) into ${root}`);

  try {
    execSync(
      `git clone --depth 1 --branch ${shellQuote(ref)} ${shellQuote(repoUrl)} ${shellQuote(root)}`,
      { stdio: 'inherit' },
    );
  } catch (err: any) {
    throw new Error(`git clone failed for ${repoUrl} (${ref}): ${err.message}`);
  }

  // Write a tiny manifest so subsequent commands can confirm provenance
  // without re-reading git.
  const manifestPath = join(root, '.sankofa-bundle.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        sankofa_engine_version: sankofaEngineVersion,
        repo_url: repoUrl,
        ref,
        installed_at_unix: Math.floor(Date.now() / 1000),
      },
      null,
      2,
    ),
  );

  return bundledFlutterInfo(sankofaEngineVersion);
}

/**
 * Try to resolve a bundled flutter for the active project. Returns null
 * if there's no project-pinned version or the bundle isn't installed.
 *
 * Resolution order (most specific to least):
 *   1. Explicit version arg
 *   2. SANKOFA_FLUTTER_BUNDLED_VERSION env var
 *   3. <projectRoot>/.sankofa/flutter-version (one-line file written by sankofa init)
 *   4. <projectRoot>/sankofa.yaml's `engine_version` key
 */
export function resolveBundledFlutter(
  projectRoot: string,
  explicitVersion?: string,
): BundledFlutterInfo | null {
  let version = explicitVersion || process.env.SANKOFA_FLUTTER_BUNDLED_VERSION;

  if (!version) {
    const pinFile = join(projectRoot, '.sankofa', 'flutter-version');
    if (existsSync(pinFile)) {
      try {
        version = readFileSync(pinFile, 'utf-8').trim();
      } catch {
        // fall through
      }
    }
  }

  if (!version) {
    const yamlPath = join(projectRoot, 'sankofa.yaml');
    if (existsSync(yamlPath)) {
      try {
        const text = readFileSync(yamlPath, 'utf-8');
        const m = text.match(/^\s*engine_version:\s*['"]?([\w.+-]+)['"]?\s*$/m);
        if (m) version = m[1];
      } catch {
        // fall through
      }
    }
  }

  if (!version) return null;
  const info = bundledFlutterInfo(version);
  return info.exists ? info : null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
