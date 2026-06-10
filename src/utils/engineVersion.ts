/**
 * # Engine version resolution — single source of truth
 *
 * Every Sankofa engine release is identified by a friendly version of the
 * form `<flutter-version>+sankofa-<N>` (e.g. `3.44.1+sankofa-1`) and lives
 * in three places that MUST stay consistent:
 *
 *   1. A git branch `phase1/sankofa-<flutter-version>` (+ an immutable tag
 *      `v<engine-version>`) in Sankofa-HQ/sankofa-flutter — the bundled SDK
 *      the CLI clones.
 *   2. CDN artifacts under
 *      `download.sankofa.dev/flutter_infra_release/flutter/<engine-rev>/…`
 *      where `<engine-rev>` is the fork commit recorded in the manifest.
 *   3. `known_engines` rows on api.sankofa.dev (release-time trust check).
 *
 * The publish pipeline writes `engines/sankofa/latest.json` on every engine
 * release; `resolveLatestEngineVersion()` reads it so `sankofa engine
 * upgrade` / `sankofa update` can move customers forward with one command.
 */

/** Public artifact CDN — fronts the sankofa-public-engine B2 bucket. */
export const SANKOFA_STORAGE_BASE_URL = 'https://download.sankofa.dev';

/**
 * Fallback when the CDN's latest.json is unreachable (offline install,
 * proxy). Bump on every engine release as part of the publish checklist.
 */
export const DEFAULT_ENGINE_VERSION = '3.44.1+sankofa-1';

/** `3.44.1+sankofa-1` → `3.44.1`. Returns null for malformed input. */
export function flutterVersionOf(engineVersion: string): string | null {
  const m = engineVersion.match(/^(\d+\.\d+\.\d+)\+sankofa-\d+$/);
  return m ? m[1] : null;
}

/**
 * Git ref in Sankofa-HQ/sankofa-flutter for a given engine version.
 *
 * Per-stable convention (locked 2026-06-09): every Flutter stable gets a
 * permanent `phase1/sankofa-<flutter-version>` branch. The pre-convention
 * 3.44.0 release lives on the legacy long-lived branch.
 */
export function branchForEngineVersion(engineVersion: string): string {
  if (engineVersion.startsWith('3.44.0+')) {
    return 'phase1/sankofa-codepush-engine-integration';
  }
  const fv = flutterVersionOf(engineVersion);
  if (!fv) {
    throw new Error(
      `Cannot derive a sankofa-flutter branch from "${engineVersion}" — ` +
        `expected the form <flutter-version>+sankofa-<N> (e.g. 3.44.1+sankofa-1).`,
    );
  }
  return `phase1/sankofa-${fv}`;
}

export interface EngineManifest {
  engine_version: string;
  engine_rev: string;
  uploaded_at_unix?: number;
  targets?: string[];
  /** CDN URL of the customer-distributable SDK tarball (the repo is private). */
  sdk_url?: string;
  /** SHA-256 of sdk.tar.gz — verified before unpacking. */
  sdk_sha256?: string;
}

/**
 * Fetch the CDN manifest for one engine version. Throws on HTTP failure —
 * callers decide whether that's fatal (install) or soft (version probe).
 */
export async function fetchEngineManifest(engineVersion: string): Promise<EngineManifest> {
  const url = `${SANKOFA_STORAGE_BASE_URL}/engines/sankofa/by-version/${encodeURIComponent(engineVersion)}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`engine manifest ${engineVersion} not on CDN (HTTP ${res.status})`);
  }
  return (await res.json()) as EngineManifest;
}

/**
 * Resolve the newest published engine version from the CDN. Falls back to
 * DEFAULT_ENGINE_VERSION when the CDN is unreachable, so installs still
 * work offline against a warm cache.
 */
export async function resolveLatestEngineVersion(): Promise<{
  version: string;
  source: 'cdn' | 'fallback';
  manifest?: EngineManifest;
}> {
  try {
    const res = await fetch(`${SANKOFA_STORAGE_BASE_URL}/engines/sankofa/latest.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const manifest = (await res.json()) as EngineManifest;
      if (manifest.engine_version) {
        return { version: manifest.engine_version, source: 'cdn', manifest };
      }
    }
  } catch {
    // fall through to the baked-in default
  }
  return { version: DEFAULT_ENGINE_VERSION, source: 'fallback' };
}
