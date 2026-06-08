import {
  existsSync,
  mkdirSync,
  statSync,
  createWriteStream,
  renameSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { resolveEngineDownloadURL, type KnownEngine } from './engineRegistry.js';

/**
 * # Engine cache
 *
 * Customer devs download a Sankofa-built engine binary once per
 * Flutter version × ABI combination, and re-use it across every
 * project they work on. The cache lives at:
 *
 *   ~/.sankofa/engines/
 *     ├── {flutter_version}/
 *     │   ├── {target_dir}/                e.g. "android-arm64-release"
 *     │   │   ├── libflutter.so            (Android) or
 *     │   │   ├── Flutter.framework.zip    (iOS)
 *     │   │   └── .meta.json               provenance from the registry
 *     │   └── ...
 *
 * Why a per-user cache:
 *
 *  - **Speed** — engines are 130–150 MB on Android. Avoiding the
 *    re-download on every new project is a 30 s → instant win.
 *  - **Disk vs network** — laptops are bigger than bandwidth (especially
 *    in Africa / Asia / LatAm, Sankofa's target markets — bandwidth is
 *    metered and slow, disk is cheap and fast).
 *  - **Offline dev** — once a dev has downloaded the engine, the next
 *    `sankofa init --deploy` works on a plane.
 *
 * Why hashed paths: each engine entry includes its SHA in `.meta.json`;
 * cache hits re-verify by SHA before declaring a hit, so a corrupted
 * file on disk gets re-downloaded automatically.
 *
 * Why not Flutter's pub-cache: that path is heavily Flutter-managed,
 * mutated by `flutter doctor`, and varies across hosts. Keeping our
 * cache separate avoids fighting Flutter.
 */

/**
 * Maps a `KnownEngine` to its on-disk filename, mirroring the layout
 * the dev server's static handler uses.
 *
 *   3.41.9 + android-arm64-v8a-release  →  android-arm64-release/libflutter.so
 *   3.41.9 + ios-device-arm64-release   →  ios-device-arm64-release/Flutter.framework.zip
 */
function targetDirForEngine(e: KnownEngine): string {
  if (e.target === 'android') {
    const abiSlug =
      e.abi === 'arm64-v8a' ? 'arm64' :
      e.abi === 'armeabi-v7a' ? 'arm' :
      e.abi === 'x86_64' ? 'x64' :
      e.abi;
    return `android-${abiSlug}-${e.runtime_mode}`;
  }
  // iOS layout already uses descriptive ABIs (device-arm64, sim-arm64, sim-x64).
  return `ios-${e.abi}-${e.runtime_mode}`;
}

function artifactNameForEngine(e: KnownEngine): string {
  return e.target === 'ios' ? 'Flutter.framework.zip' : 'libflutter.so';
}

export interface EngineCacheEntry {
  /** The engine this cache entry holds. */
  engine: KnownEngine;
  /** Absolute path of the cached binary on disk. */
  path: string;
  /** Path to the sidecar `.meta.json` provenance file. */
  metaPath: string;
  /** Resolved when the cached file exists AND its SHA matches the registry. */
  valid: boolean;
}

/** Absolute root of the cache for the current user. */
export function engineCacheRoot(): string {
  // $SANKOFA_HOME overrides for CI / test isolation.
  const root = process.env.SANKOFA_HOME || join(homedir(), '.sankofa');
  return join(root, 'engines');
}

export function locateEngineInCache(engine: KnownEngine): EngineCacheEntry {
  const root = engineCacheRoot();
  const dir = join(root, engine.flutter_version, targetDirForEngine(engine));
  const path = join(dir, artifactNameForEngine(engine));
  const metaPath = join(dir, '.meta.json');

  let valid = false;
  if (existsSync(path)) {
    // For iOS Flutter.framework.zip we DON'T re-hash the zip on every
    // cache hit — the SHAs in our registry are for the contained
    // `Flutter` Mach-O, not the zip. The `.meta.json` records the
    // last-verified SHA so cache hits are O(1).
    if (engine.target === 'ios') {
      valid = existsSync(metaPath);
    } else {
      // Android cache hits re-hash. ~150 MB stream-hashes in <1s on
      // modern SSDs; worth the safety against bit-rot / partial
      // downloads.
      try {
        valid = sha256OfFile(path) === engine.sha256.toLowerCase();
      } catch {
        valid = false;
      }
    }
  }
  return { engine, path, metaPath, valid };
}

/**
 * Stream-download an engine into the cache, with a TTY progress bar
 * when stdout is a tty. The download:
 *
 *  1. Writes to `path.partial` so a kill mid-download doesn't leave a
 *     corrupt-but-named-correctly file the next run would trust.
 *  2. Streams a SHA-256 computation alongside the write so we don't
 *     re-read the whole file after.
 *  3. Verifies the SHA matches `engine.sha256` BEFORE the atomic
 *     rename. Mismatches refuse to write the final file and surface
 *     a clear error.
 *  4. Writes `.meta.json` with provenance so future cache hits don't
 *     need a registry round-trip to recognize this entry.
 *
 * Returns the final cache entry. Throws on any failure.
 */
export async function downloadEngineIntoCache(
  engine: KnownEngine,
  opts: { onProgress?: (received: number, total: number) => void } = {},
): Promise<EngineCacheEntry> {
  const entry = locateEngineInCache(engine);
  mkdirSync(dirname(entry.path), { recursive: true });

  const url = resolveEngineDownloadURL(engine);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok || !res.body) {
    throw new Error(
      `Engine download failed: HTTP ${res.status} from ${url}.\n` +
        `(${engine.flutter_version} ${engine.target} ${engine.abi})`,
    );
  }
  const total = engine.size_bytes;
  const partialPath = `${entry.path}.partial`;
  const hash = createHash('sha256');
  const file = createWriteStream(partialPath);
  let received = 0;

  // The reader pipes ReadableStream → file. We tap each chunk into
  // the hash + progress callback before forwarding to disk so the
  // whole file is hashed in a single pass.
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        received += value.length;
        hash.update(value);
        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => file.once('drain', resolve));
        }
        opts.onProgress?.(received, total);
      }
    }
  } finally {
    await new Promise<void>((resolve) => file.end(resolve));
  }

  const downloadedSha = hash.digest('hex');
  if (downloadedSha !== engine.sha256.toLowerCase()) {
    // Refuse to keep a corrupt download — the registry's SHA is the
    // source of trust, not whatever bytes the network handed us.
    try { unlinkSync(partialPath); } catch { /* ignore */ }
    throw new Error(
      `Engine SHA mismatch.\n` +
        `  expected: ${engine.sha256}\n` +
        `  got:      ${downloadedSha}\n` +
        `Download was corrupt or tampered with — refusing to write to the cache.`,
    );
  }

  // Atomic move — only after we've proven the bytes are right.
  renameSync(partialPath, entry.path);
  writeMeta(entry.metaPath, engine);

  return { ...entry, valid: true };
}

/**
 * Cache hit path — returns the entry if a valid cached copy exists.
 * Returns null when the cache is empty / corrupt / SHA-mismatched.
 */
export function tryEngineCacheHit(engine: KnownEngine): EngineCacheEntry | null {
  const entry = locateEngineInCache(engine);
  return entry.valid ? entry : null;
}

/** Convenience: cache-hit or download. The most common call shape. */
export async function ensureEngineCached(
  engine: KnownEngine,
  opts: { onProgress?: (received: number, total: number) => void } = {},
): Promise<EngineCacheEntry> {
  const hit = tryEngineCacheHit(engine);
  if (hit) return hit;
  return downloadEngineIntoCache(engine, opts);
}

/** List every cached engine for the current user. Used by `sankofa engine list`. */
export function listCachedEngines(): EngineCacheEntry[] {
  const root = engineCacheRoot();
  if (!existsSync(root)) return [];
  const out: EngineCacheEntry[] = [];

  for (const fv of readdirSync(root, { withFileTypes: true })) {
    if (!fv.isDirectory()) continue;
    const versionDir = join(root, fv.name);
    for (const td of readdirSync(versionDir, { withFileTypes: true })) {
      if (!td.isDirectory()) continue;
      const targetDir = join(versionDir, td.name);
      const metaPath = join(targetDir, '.meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as KnownEngine;
        const path = join(targetDir, artifactNameForEngine(meta));
        out.push({
          engine: meta,
          path,
          metaPath,
          valid: existsSync(path),
        });
      } catch {
        /* ignore corrupt meta */
      }
    }
  }
  return out;
}

function writeMeta(path: string, engine: KnownEngine): void {
  writeFileSync(path, JSON.stringify(engine, null, 2), 'utf-8');
}

/**
 * Stream-hash a file with SHA-256 — synchronous so callers can use it
 * during cache-hit checks. 64 KiB chunks bound the working set
 * regardless of file size. Exported so `sankofa engine register` can
 * derive the SHA from a user-pointed file without duplicating the
 * streaming-hash loop.
 */
export function sha256OfFile(path: string): string {
  const hash = createHash('sha256');
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

/** Human-readable byte size for the progress UI. */
export function formatBytesHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** Cache helper for tests + the `sankofa engine clean` subcommand. */
export function cacheStatsFor(engine: KnownEngine): { exists: boolean; sizeBytes: number } {
  const entry = locateEngineInCache(engine);
  if (!existsSync(entry.path)) return { exists: false, sizeBytes: 0 };
  return { exists: true, sizeBytes: statSync(entry.path).size };
}
