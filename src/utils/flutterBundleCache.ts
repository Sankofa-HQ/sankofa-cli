import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  branchForEngineVersion,
  SANKOFA_STORAGE_BASE_URL,
} from './engineVersion.js';

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
 * Returns true when the bundled SDK's dart-sdk cache is fully populated
 * (i.e. the dart executable exists at the standard path). Used to decide
 * whether a warm-up is needed.
 */
function isDartSdkUsable(root: string): boolean {
  const dart = join(root, 'bin', 'cache', 'dart-sdk', 'bin', 'dart');
  try {
    return statSync(dart).isFile();
  } catch {
    return false;
  }
}

/**
 * Force the bundled Flutter SDK to download + extract its dart-sdk
 * cache. This is what the first invocation of `bin/flutter` does
 * implicitly via `update_dart_sdk.sh`, but invoking it here turns the
 * one-time ~30s pause + ~80 MB network fetch into a visible step of
 * `sankofa init --deploy` (with a clear "first-time bootstrap" label)
 * instead of a confusing silent pause inside the first
 * `sankofa release` / `sankofa patch`.
 *
 * If the warm-up fails (network blip, restrictive proxy, mid-download
 * SIGINT, etc.), wipe any half-populated dart-sdk + stamp state so the
 * next `sankofa init --deploy` rerun starts from a clean slate instead
 * of relying on a stamp file that lies about what's on disk.
 */
function warmDartSdkCache(root: string, onProgress?: (msg: string) => void): void {
  if (isDartSdkUsable(root)) {
    return;
  }
  onProgress?.('Warming Dart SDK cache (first-time bootstrap, ~30 s)…');
  const bin = join(root, 'bin', 'flutter');
  try {
    execSync(`${shellQuote(bin)} --version`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        FLUTTER_SUPPRESS_ANALYTICS: 'true',
        // We don't want analytics popups + we don't want this to update the
        // user's normal flutter cache (FLUTTER_ROOT scopes the invocation).
        FLUTTER_ROOT: root,
        // The fork's engine.version pins a SANKOFA engine rev; its dart-sdk
        // + precache artifacts exist only on Sankofa's CDN, never on
        // Google's. Without this the bootstrap 404s against
        // storage.googleapis.com.
        FLUTTER_STORAGE_BASE_URL:
          process.env.FLUTTER_STORAGE_BASE_URL || SANKOFA_STORAGE_BASE_URL,
      },
    });
  } catch (err: any) {
    // Wipe the partial state so the customer can re-run init and get a
    // clean download. Without this, the broken stamp files convince
    // shared.sh "dart-sdk is fresh, no need to redownload" — and every
    // subsequent flutter invocation fails the same way.
    cleanDartSdkCache(root);
    throw new Error(
      `Sankofa bundled Flutter dart-sdk bootstrap failed: ${err?.message ?? err}\n` +
        `Re-run \`sankofa init --deploy\` once network/proxy access is available.`,
    );
  }
  if (!isDartSdkUsable(root)) {
    cleanDartSdkCache(root);
    throw new Error(
      'Sankofa bundled Flutter dart-sdk bootstrap completed but produced no usable `dart` ' +
        'binary. Re-run `sankofa init --deploy` to retry.',
    );
  }
}

/**
 * Remove every artifact the dart-sdk download writes, so the next warm-up
 * fully redownloads instead of trusting a stale stamp.
 */
function cleanDartSdkCache(root: string): void {
  const cacheDir = join(root, 'bin', 'cache');
  for (const name of [
    'dart-sdk',
    'engine-dart-sdk.stamp',
    'engine.stamp',
    'engine.realm',
    'engine_stamp.json',
    'engine_stamp.stamp',
    'flutter_tools.stamp',
    'flutter_tools.snapshot',
  ]) {
    try {
      rmSync(join(cacheDir, name), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
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
    // Even on a cache hit, force the dart-sdk warm-up if the previous
    // run's bootstrap didn't complete (interrupted download, manual
    // cleanup, etc). Idempotent: no-op when dart-sdk is already usable.
    warmDartSdkCache(info.root, opts.onProgress);
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

  // Primary path: download the SDK tarball published by every engine
  // release (the sankofa-flutter repo is private — customers can't clone
  // it). Falls back to git clone for pre-tarball versions and for
  // Sankofa-internal machines with repo access.
  let installedVia = '';
  try {
    installedVia = installFromTarball(sankofaEngineVersion, root, opts.onProgress);
  } catch (err: any) {
    opts.onProgress?.(`SDK tarball unavailable (${err.message}) — falling back to git clone`);
  }

  const repoUrl = opts.repoUrl || SANKOFA_FLUTTER_REPO_URL;
  // Per-stable branches: 3.44.1+sankofa-1 → phase1/sankofa-3.44.1.
  const ref = opts.ref || branchForEngineVersion(sankofaEngineVersion);

  if (!installedVia) {
    opts.onProgress?.(`Cloning ${repoUrl} (${ref}) into ${root}`);
    try {
      execSync(
        `git clone --depth 1 --branch ${shellQuote(ref)} ${shellQuote(repoUrl)} ${shellQuote(root)}`,
        { stdio: 'inherit' },
      );
      // A depth-1 clone has no tags, so flutter_tools reports version
      // "0.0.0-unknown" and every pub SDK constraint fails. Tag the tip
      // locally with the Flutter version (mirrors what the tarball ships).
      const fv = sankofaEngineVersion.split('+')[0];
      if (/^\d+\.\d+\.\d+$/.test(fv)) {
        try {
          execSync(`git -C ${shellQuote(root)} tag -f ${shellQuote(fv)}`, { stdio: 'ignore' });
        } catch { /* cosmetic — version banner only */ }
      }
      installedVia = `git:${ref}`;
    } catch (err: any) {
      throw new Error(
        `Could not install the Sankofa Flutter SDK ${sankofaEngineVersion}: ` +
          `the CDN tarball was unavailable and git clone failed (${err.message}). ` +
          `Check network access to ${SANKOFA_STORAGE_BASE_URL}.`,
      );
    }
  }

  // Write a tiny manifest so subsequent commands can confirm provenance
  // without re-reading git.
  const manifestPath = join(root, '.sankofa-bundle.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        sankofa_engine_version: sankofaEngineVersion,
        installed_via: installedVia,
        installed_at_unix: Math.floor(Date.now() / 1000),
      },
      null,
      2,
    ),
  );

  // Force the first-run dart-sdk download NOW (during init), not later
  // (during the customer's first release/patch). If anything goes wrong
  // — bad network, restrictive proxy, Ctrl-C during download — this
  // surfaces immediately with a clear "rerun init" message instead of
  // silently corrupting the cache for next time.
  warmDartSdkCache(root, opts.onProgress);

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

/**
 * Download + verify + unpack the SDK tarball for `version` into `root`.
 * Returns a provenance string on success; throws when the manifest has
 * no sdk_url (pre-tarball release) or any download/verify step fails.
 *
 * Synchronous on purpose: installBundledFlutter is sync and is called
 * from sync contexts (init, engine install). curl handles the transfer;
 * the SHA check streams the file once via Node's crypto.
 */
// HTTP downloader portability: macOS always ships curl, but minimal Linux
// may not. Prefer curl, fall back to wget, and give a clear error if neither
// exists (rather than the misleading "CDN unavailable / git clone failed").
let _downloader: 'curl' | 'wget' | null | undefined;
function hasCmd(c: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${c}` : `command -v ${c}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
function pickDownloader(): 'curl' | 'wget' {
  if (_downloader === undefined) {
    _downloader = hasCmd('curl') ? 'curl' : hasCmd('wget') ? 'wget' : null;
  }
  if (!_downloader) {
    throw new Error(
      'Neither curl nor wget is available. Install one (e.g. `sudo apt install curl`) — Flutter also requires curl on Linux.',
    );
  }
  return _downloader;
}
function httpGetText(url: string, maxSeconds = 30): string {
  return pickDownloader() === 'curl'
    ? execSync(`curl -fsSL --max-time ${maxSeconds} ${shellQuote(url)}`, { encoding: 'utf-8' })
    : execSync(`wget -qO- --timeout=${maxSeconds} ${shellQuote(url)}`, { encoding: 'utf-8' });
}
function httpGetToFile(url: string, dest: string, maxSeconds = 900): void {
  if (pickDownloader() === 'curl') {
    execSync(
      `curl -fSL --retry 3 --retry-all-errors --max-time ${maxSeconds} -o ${shellQuote(dest)} ${shellQuote(url)}`,
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  } else {
    execSync(
      `wget -q --tries=3 --timeout=${maxSeconds} -O ${shellQuote(dest)} ${shellQuote(url)}`,
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  }
}
// SHA-256 in pure Node (createHash) — no dependency on `shasum`, which is
// absent on many Linux distros (they ship `sha256sum` instead).
function sha256OfFile(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function installFromTarball(
  version: string,
  root: string,
  onProgress?: (msg: string) => void,
): string {
  // ?cb= forces edge revalidation — manifests are mutable pointers.
  const manifestUrl = `${SANKOFA_STORAGE_BASE_URL}/engines/sankofa/by-version/${encodeURIComponent(version)}.json?cb=${Date.now()}`;
  let manifest: { sdk_url?: string; sdk_sha256?: string };
  try {
    manifest = JSON.parse(httpGetText(manifestUrl, 30));
  } catch (err: any) {
    throw new Error(`manifest fetch failed for ${version}: ${err.message}`);
  }
  if (!manifest.sdk_url || !manifest.sdk_sha256) {
    throw new Error(`no sdk tarball published for ${version}`);
  }

  const tarPath = join(tmpdir(), `sankofa-sdk-${version.replace(/[^\w.-]/g, '_')}.tar.gz`);
  onProgress?.(`Downloading SDK tarball for ${version}…`);
  httpGetToFile(manifest.sdk_url, tarPath, 900);

  onProgress?.('Verifying SDK tarball (sha256)…');
  const actual = sha256OfFile(tarPath);
  if (actual !== manifest.sdk_sha256.toLowerCase()) {
    try { unlinkSync(tarPath); } catch { /* ignore */ }
    throw new Error(
      `SDK tarball SHA mismatch (expected ${manifest.sdk_sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
    );
  }

  onProgress?.('Unpacking SDK…');
  mkdirSync(root, { recursive: true });
  try {
    execSync(`tar -xzf ${shellQuote(tarPath)} -C ${shellQuote(root)}`, { stdio: 'inherit' });
  } catch (err: any) {
    // A half-unpacked SDK is worse than none — wipe so the next attempt
    // (or the git fallback) starts clean.
    rmSync(root, { recursive: true, force: true });
    throw new Error(`tarball unpack failed: ${err.message}`);
  } finally {
    try { unlinkSync(tarPath); } catch { /* ignore */ }
  }
  return `tarball:${manifest.sdk_url}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
