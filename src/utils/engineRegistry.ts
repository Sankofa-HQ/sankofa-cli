import { findProjectConfig, loadGlobalConfig, resolveAuth } from './config.js';

/**
 * # Engine trust registry — CLI client
 *
 * Sankofa Deploy: Flutter Code can only patch an app that was built
 * with a Sankofa-built `libflutter.so`. The server keeps a list of
 * known-good engine SHAs (see `server/engine/ee/deploy/engines_registry.go`);
 * before publishing a release, the CLI fetches that list and verifies
 * the libflutter.so embedded in the just-built APK / .ipa is on it.
 *
 * Two layers of caching:
 *
 *  - **15-minute in-process** — for the duration of a single CLI
 *    invocation, the first `fetchKnownEngines()` call resolves the
 *    list and subsequent calls (e.g. release + engine-cache hits in
 *    the same run) reuse it. The TTL is just a guardrail; the cache
 *    is wiped when the CLI exits.
 *  - **No on-disk cache** — the registry is small (~6 entries today)
 *    and changes whenever we ship a new engine. Stale entries cause
 *    confusing "your engine is unknown" failures, so we re-fetch
 *    every run.
 *
 * On network failure the CLI does NOT silently fall back to "trust
 * everything." A broken connection to the registry is treated the
 * same as the engine being unknown — better to refuse the release
 * than ship a poisoned patch.
 */

export interface KnownEngine {
  flutter_version: string;
  target: 'android' | 'ios' | string;
  abi: string;
  runtime_mode: string;
  sankofa_engine_version: string;
  is_modified: boolean;
  sha256: string;
  size_bytes: number;
  source_commit: string;
  built_at: string;
  download_url: string;
}

interface KnownEnginesResponse {
  engines: KnownEngine[];
  count: number;
}

interface RegistryQuery {
  flutterVersion?: string;
  target?: 'android' | 'ios';
  modifiedOnly?: boolean;
}

const TTL_MS = 15 * 60 * 1000;
let cachedAt = 0;
let cachedEngines: KnownEngine[] | null = null;

/**
 * Fetch the full registry. Cached for the duration of the CLI process
 * (subject to TTL).
 *
 * Throws if the server is unreachable or returns non-2xx — callers
 * should treat that as "we don't know if your engine is trusted" and
 * refuse the release.
 */
export async function fetchKnownEngines(
  query: RegistryQuery = {},
): Promise<KnownEngine[]> {
  if (cachedEngines && Date.now() - cachedAt < TTL_MS) {
    return filterEngines(cachedEngines, query);
  }

  const { endpoint } = resolveAuth();
  const params = new URLSearchParams();
  if (query.flutterVersion) params.set('flutter_version', query.flutterVersion);
  if (query.target) params.set('target', query.target);
  if (query.modifiedOnly) params.set('modified', 'true');

  const url = `${endpoint}/api/v1/deploy/engines/known${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(
      `Engine registry returned HTTP ${res.status} from ${url}. ` +
        `Refusing to publish without verifying the engine — re-run when the server is reachable.`,
    );
  }
  const body = (await res.json()) as KnownEnginesResponse;
  cachedEngines = body.engines || [];
  cachedAt = Date.now();
  return filterEngines(cachedEngines, query);
}

/**
 * Look up an engine by its SHA256. Returns `null` when the SHA is not
 * in the registry — caller should treat that as "unknown engine,
 * refuse the release."
 *
 * NOTE this does NOT silently re-fetch on miss; the caller is
 * expected to have already called fetchKnownEngines() (or accept a
 * single registry round-trip on first miss).
 */
export async function findEngineBySha(sha256: string): Promise<KnownEngine | null> {
  const engines = await fetchKnownEngines();
  for (const e of engines) {
    if (e.sha256.toLowerCase() === sha256.toLowerCase()) return e;
  }
  return null;
}

/**
 * Resolves the absolute download URL for an engine. The registry
 * stores either a relative path (`/engines/3.41.9/...` — dev server's
 * static handler) or an absolute URL (Slice 5's B2 signed URL).
 *
 * Caller composes against the CLI's configured endpoint when relative.
 */
export function resolveEngineDownloadURL(engine: KnownEngine): string {
  if (/^https?:\/\//i.test(engine.download_url)) {
    return engine.download_url;
  }
  const { endpoint } = resolveAuth();
  return `${endpoint.replace(/\/$/, '')}${engine.download_url}`;
}

/** Clear the cache. Used by tests + the `sankofa engine refresh` subcommand. */
export function resetEngineRegistryCache(): void {
  cachedEngines = null;
  cachedAt = 0;
}

/**
 * Resolve the API endpoint without requiring a deploy token. Used by
 * the Sankofa-internal `sankofa engine register` admin path —
 * registration auth uses SANKOFA_ENGINE_REGISTRY_TOKEN (a different
 * secret from the deploy token) so we shouldn't force the caller to
 * be logged in as a customer.
 */
export function resolveEndpointOnly(): string {
  return (
    process.env.SANKOFA_ENDPOINT ||
    findProjectConfig()?.endpoint ||
    loadGlobalConfig().endpoint ||
    'https://api.sankofa.dev'
  );
}

/**
 * Payload accepted by POST /api/v1/admin/engines/. Matches the
 * server-side handler in `server/engine/ee/deploy/handlers.go`.
 */
export interface RegisterEnginePayload {
  flutter_version: string;
  target: string;
  abi: string;
  runtime_mode?: string;
  sankofa_engine_version: string;
  is_modified: boolean;
  sha256: string;
  size_bytes: number;
  source_commit?: string;
  object_key: string;
  built_at?: string;
}

/**
 * Register one engine with the server's known_engines table.
 *
 * Auth is the engine registry token — a different secret from the
 * deploy token. It must match the server's `SANKOFA_ENGINE_REGISTRY_TOKEN`
 * env var. Source it from `--token` flag or `SANKOFA_ENGINE_REGISTRY_TOKEN`
 * env var; refuse if missing rather than POSTing with no auth.
 *
 * Throws on non-2xx so the CLI can surface the server's error body.
 */
export async function registerKnownEngine(
  payload: RegisterEnginePayload,
  opts: { endpoint?: string; token?: string } = {},
): Promise<KnownEngine> {
  const endpoint = opts.endpoint || resolveEndpointOnly();
  const token = opts.token || process.env.SANKOFA_ENGINE_REGISTRY_TOKEN;
  if (!token) {
    throw new Error(
      'No engine registry token. Pass --token <hex> or set SANKOFA_ENGINE_REGISTRY_TOKEN. ' +
        '(This is the server\'s admin token from SANKOFA_ENGINE_REGISTRY_TOKEN, NOT a deploy token.)',
    );
  }

  const url = `${endpoint.replace(/\/$/, '')}/api/v1/admin/engines/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Engine-Registry-Token': token,
    },
    body: JSON.stringify({
      runtime_mode: 'release',
      built_at: new Date().toISOString(),
      ...payload,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Register engine failed: HTTP ${res.status} from ${url}\n${text}`.trim(),
    );
  }

  // Invalidate the in-process registry cache so a subsequent
  // fetchKnownEngines() call in the same process sees the new row.
  resetEngineRegistryCache();

  // Server response shape: { "engine": KnownEngine }.
  const body = (await res.json()) as { engine?: KnownEngine };
  if (!body.engine) {
    throw new Error('Server returned 2xx but no engine in response body');
  }
  return body.engine;
}

function filterEngines(
  engines: KnownEngine[],
  query: RegistryQuery,
): KnownEngine[] {
  return engines.filter((e) => {
    if (query.flutterVersion && e.flutter_version !== query.flutterVersion) return false;
    if (query.target && e.target !== query.target) return false;
    if (query.modifiedOnly && !e.is_modified) return false;
    return true;
  });
}
