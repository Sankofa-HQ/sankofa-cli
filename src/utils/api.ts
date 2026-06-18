import { statSync, openAsBlob, createReadStream } from 'fs';
import { createHash } from 'crypto';
import { resolveAuth } from './config.js';
import { normalizeEnvironment, normalizePlatform } from './validation.js';

/**
 * Build an undici dispatcher with generous timeouts for large uploads.
 * Returns undefined if undici isn't importable (the default fetch
 * timeouts then apply). Shared by the presigned PUT and the release POST.
 */
async function makeUploadDispatcher(): Promise<any> {
  try {
    // @ts-ignore — undici ships with Node >= 18 but isn't typed as an
    // importable module path. Dynamic import resolves at runtime.
    const undici = (await import('undici' as any)) as any;
    return new undici.Agent({
      headersTimeout: 20 * 60 * 1000,
      bodyTimeout: 20 * 60 * 1000,
      connectTimeout: 30 * 1000,
    });
  } catch {
    return undefined;
  }
}

/** Stream a file through SHA-256 without loading it into memory. */
function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

interface PresignedUpload {
  object_key: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Ask the server for a presigned PUT URL for a large native/preview
 * artifact. Returns null when the server doesn't expose the endpoint
 * (older deploy build → 404), so the caller can fall back to the legacy
 * inline multipart upload.
 */
async function presignNativeArtifact(
  endpoint: string,
  projectId: string,
  kind: string,
  sizeBytes: number,
  sha256: string,
  dispatcher: any,
): Promise<PresignedUpload | null> {
  const url = `${endpoint}/api/v1/deploy/releases/presign?projectId=${projectId}`;
  const init: any = {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ native_artifact_kind: kind, size_bytes: sizeBytes, sha256 }),
  };
  if (dispatcher) init.dispatcher = dispatcher;
  const res = await fetch(url, init);
  // Fall back to the inline multipart upload (which goes through POST
  // /releases — the deploy-token-accepting path) when presign is unavailable
  // OR rejects this credential:
  //   404 → server predates presigned uploads
  //   401/403 → presign endpoint is gated by dashboard-JWT-only auth and
  //     rejects Deploy Tokens. Throwing here would abort the whole release
  //     with a misleading "Invalid token"; instead fall back so a valid
  //     Deploy Token still publishes via the inline path.
  if (res.status === 404 || res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw await readAPIError(res, `Presign failed (${res.status})`);
  return (await res.json()) as PresignedUpload;
}

/** PUT a file straight to object storage using a presigned URL. */
async function putToPresignedUrl(
  presigned: PresignedUpload,
  filePath: string,
  dispatcher: any,
): Promise<void> {
  const contentType = presigned.headers['Content-Type'] || presigned.headers['content-type'] || 'application/octet-stream';
  const blob = await openAsBlob(filePath, { type: contentType });
  const init: any = {
    method: presigned.method || 'PUT',
    headers: { ...presigned.headers },
    body: blob,
  };
  if (dispatcher) init.dispatcher = dispatcher;
  let res;
  try {
    res = await fetch(presigned.upload_url, init);
  } catch (err: any) {
    const detail = err?.cause?.message || err?.message || 'network error';
    throw new Error(`Direct upload of the native artifact to storage failed: ${detail}`);
  }
  if (!res.ok) {
    let hint = '';
    if (res.status === 403) {
      hint = ' — the upload URL may have expired (60-min limit) or the file changed mid-upload; re-run the command.';
    } else if (res.status === 413) {
      hint = ' — the storage provider rejected the object size.';
    }
    const body = await res.text().catch(() => '');
    const snippet = body ? `: ${body.replace(/\s+/g, ' ').slice(0, 180)}` : '';
    throw new Error(`Direct upload of the native artifact to storage failed (HTTP ${res.status})${hint}${snippet}`);
  }
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}

async function apiFetch(path: string, opts: FetchOptions = {}): Promise<Response> {
  const { endpoint } = resolveAuth();
  const url = `${endpoint}${path}`;

  const headers: Record<string, string> = {
    ...getAuthHeaders(),
    ...opts.headers,
  };

  // Use global fetch (Node 18+)
  return fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  });
}

/** Build standard auth headers for dashboard API calls */
function getAuthHeaders(): Record<string, string> {
  const { token, projectId } = resolveAuth();
  if (token.startsWith('sk_live_') || token.startsWith('sk_test_')) {
    throw new Error('Publishing requires a Deploy Token (sk_deploy_...). SDK live/test keys are only for app runtime update checks.');
  }
  return {
    'Authorization': `Bearer ${token}`,
    ...(projectId ? { 'x-project-id': projectId } : {}),
  };
}

/** Humanize a deploy metric key for user-facing quota messages. */
function metricLabel(metric: string): string {
  switch (metric) {
    case 'native_artifact_mb':
      return 'preview/native artifact';
    case 'bundle_mb':
      return 'bundle';
    case 'app':
      return 'apps';
    default:
      return metric;
  }
}

async function readAPIError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as any;
  if (body && typeof body === 'object') {
    // Structured tier/quota errors → clear, actionable messages.
    if (body.error === 'quota_exceeded') {
      const what = metricLabel(String(body.metric || ''));
      const used = body.used != null ? `${body.used} MB` : 'this upload';
      // tier "*" means the absolute hard cap, not a plan allowance.
      if (body.current === '*') {
        return new Error(
          `This ${what} is ${used}, over the maximum allowed ${body.limit} MB. Split or shrink the artifact.`,
        );
      }
      return new Error(
        `This ${what} is ${used}, over your ${body.current ?? 'current'} plan's ${body.limit} MB limit. ` +
          `Upgrade your plan or reduce the size — https://sankofa.dev/pricing`,
      );
    }
    if (body.error === 'tier_required') {
      return new Error(
        `${body.feature ?? 'This feature'} requires the ${body.required ?? 'a higher'} plan ` +
          `(you're on ${body.current ?? 'your current plan'}). Upgrade at https://sankofa.dev/pricing`,
      );
    }
    if (body.error || body.message) return new Error(body.error || body.message);
  }
  return new Error(fallback);
}

/** List releases for the current project */
export async function listReleases(env: string = 'live', platform?: string): Promise<any[]> {
  const { endpoint, projectId } = resolveAuth();
  if (!projectId) {
    throw new Error('No project selected. Run `sankofa login --deploy-token <token> --project-id <id>` or set SANKOFA_PROJECT_ID.');
  }
  const environment = normalizeEnvironment(env);
  const params = new URLSearchParams({ projectId, environment });
  if (platform) params.set('platform', normalizePlatform(platform));

  const res = await fetch(`${endpoint}/api/v1/deploy/releases?${params}`, {
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    throw await readAPIError(res, `Failed to list releases (${res.status})`);
  }
  return res.json();
}

/** Upload a bundle to the server */
export async function uploadRelease(
  bundlePath: string,
  metadata: {
    label: string;
    target_binary_version: string;
    platform: string;
    description?: string;
    is_mandatory?: boolean;
    rollout_percentage?: number;
    environment?: string;
    native_artifact_path?: string;
    native_artifact_kind?: string;
    /** Phase 8: bundle runtime kind. Defaults to react-native server-side. */
    runtime?: 'react-native' | 'flutter-code';
    /**
     * Phase 8: Flutter engine version this bundle was built against (e.g.
     * "3.41.9+sankofa-1"). Required when runtime === 'flutter-code'.
     */
    engine_version?: string;
  },
  onProgress?: (uploaded: number, total: number) => void,
): Promise<any> {
  const { endpoint, projectId } = resolveAuth();
  if (!projectId) {
    throw new Error('No project selected. Run `sankofa login --deploy-token <token> --project-id <id>` or set SANKOFA_PROJECT_ID.');
  }
  const environment = normalizeEnvironment(metadata.environment);
  const platform = normalizePlatform(metadata.platform);

  const stats = statSync(bundlePath);
  const totalSize = stats.size;

  const form = new FormData();
  // Use openAsBlob() — streams the file from disk instead of loading the
  // whole thing into memory as a Buffer → Uint8Array copy. Node 24's
  // fetch is flaky with Blobs built from >20MB in-memory Uint8Arrays
  // (connection resets mid-upload). openAsBlob lazy-streams the file.
  //
  // Runtime-specific multipart payload:
  //   react-native           → ota.zip      (application/zip),          bundle_format=zip
  //   flutter-code (ios+android) → patch.skdp (application/octet-stream), bundle_format=skdp
  //                            (SANKOFA_KBC_ENVELOPE, β.4 spec)
  //
  // β.3 ships ONE cross-platform OTA pipeline: KBC bytecode wrapped in a
  // `.skdp` envelope, applied in the engine's interpreter on BOTH iOS and
  // Android. KBC is platform-independent, so the same envelope serves both.
  // The legacy Android `libapp.so` binary-diff path is retired.
  //
  // Server handling (ee/deploy/handlers.go:760): for platform=ios it
  // validates the envelope (magic+sha+sig) and stores it as `patch.skdp`;
  // for platform=android it stores the uploaded bytes verbatim under a
  // `libapp.so` object key (a cosmetic filename — the device downloads the
  // stored bytes and parses them as an envelope regardless, re-verifying
  // sha + Ed25519 on-device in kbc_loader.dart). So uploading `.skdp` bytes
  // for android flows through correctly without a server change.
  const isFlutterCode = metadata.runtime === 'flutter-code';
  const bundleContentType = isFlutterCode ? 'application/octet-stream' : 'application/zip';
  const bundleFilename = isFlutterCode ? 'patch.skdp' : 'ota.zip';
  const bundleFormat = isFlutterCode ? 'skdp' : 'zip';
  const bundleBlob = await openAsBlob(bundlePath, { type: bundleContentType });
  form.append('bundle', bundleBlob, bundleFilename);
  form.append('bundle_format', bundleFormat);
  // Large native/preview artifacts (simulator .app.zip / .apk) upload
  // DIRECTLY to object storage via a presigned PUT, so they never
  // traverse the API request body (Cloudflare/nginx/Fiber size limits).
  // Falls back to inline multipart when the server predates the
  // presign endpoint (404).
  const dispatcher = await makeUploadDispatcher();
  if (metadata.native_artifact_path) {
    const kind = metadata.native_artifact_kind || '';
    const nativeStat = statSync(metadata.native_artifact_path);
    const nativeSha = await sha256File(metadata.native_artifact_path);
    // presignNativeArtifact THROWS a clear error on real failures
    // (size/quota exceeded → 402, rate limited → 429, etc.) and returns
    // null ONLY when the server predates the presign endpoint (404).
    // We deliberately do NOT swallow errors here — a quota rejection
    // must reach the user, not silently fall back and fail confusingly.
    const presigned = await presignNativeArtifact(
      endpoint,
      projectId,
      kind,
      nativeStat.size,
      nativeSha,
      dispatcher,
    );
    if (presigned) {
      await putToPresignedUrl(presigned, metadata.native_artifact_path, dispatcher);
      form.append('native_artifact_object_key', presigned.object_key);
      form.append('native_artifact_kind', kind);
      form.append('native_artifact_sha256', nativeSha);
      form.append('native_artifact_size_bytes', String(nativeStat.size));
    } else {
      // Server has no presign endpoint (older build) → inline multipart.
      // Only succeeds if the artifact is under the API body limits; a
      // large one will fail at the POST below with a clear message.
      const nativeBlob = await openAsBlob(metadata.native_artifact_path, {
        type: 'application/octet-stream',
      });
      form.append('native_artifact', nativeBlob, metadata.native_artifact_path.split('/').pop() || 'native-artifact');
      form.append('native_artifact_kind', kind);
    }
  }
  form.append('metadata', JSON.stringify({
    ...metadata,
    native_artifact_path: undefined,
    native_artifact_kind: undefined,
    platform,
    environment,
    rollout_percentage: metadata.rollout_percentage ?? 100,
  }));

  const uploadUrl = `${endpoint}/api/v1/deploy/releases?projectId=${projectId}`;
  let res;
  try {
    // Release uploads can take several minutes when the server does the
    // full pipeline (B2/S3 upload, SHA256 verification, ClickHouse
    // metadata). The shared `dispatcher` (built above) bumps fetch's
    // 5-minute headers timeout to 20 min for slow networks + cold
    // storage; it's undefined when undici isn't importable, in which
    // case the default fetch timeouts apply.
    const fetchInit: any = {
      method: 'POST',
      headers: { ...getAuthHeaders() },
      body: form,
    };
    if (dispatcher) fetchInit.dispatcher = dispatcher;
    res = await fetch(uploadUrl, fetchInit);
  } catch (err: any) {
    // Node's fetch throws TypeError("fetch failed") for network-layer
    // problems and hides the real cause in err.cause. Unwrap it so the
    // user sees "connection refused" / "ENOTFOUND" / cert issues etc.
    const cause = err?.cause;
    const code = cause?.code || cause?.errno;
    const hint = networkErrorHint(code, uploadUrl);
    const detail = cause?.message || err?.message || 'unknown network error';
    throw new Error(`Upload failed: ${detail}${code ? ` (${code})` : ''}\n  → ${hint}`);
  }

  if (!res.ok) {
    throw await readAPIError(res, `Upload failed (${res.status})`);
  }

  return res.json();
}

function networkErrorHint(code: string | undefined, url: string): string {
  const endpoint = new URL(url).origin;
  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is listening at ${endpoint}. Start your Sankofa server or check the endpoint in .sankofa.json.`;
    case 'ENOTFOUND':
      return `Cannot resolve the hostname in ${endpoint}. Check your endpoint URL.`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `Connection to ${endpoint} timed out. Is the server reachable from this network?`;
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `TLS certificate problem at ${endpoint}. For self-hosted dev servers, use http:// instead of https://, or install a valid cert.`;
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return `Connection to ${endpoint} was reset mid-upload. The server may have a body-size limit; check nginx/caddy/server config.`;
    default:
      return `Check that ${endpoint} is reachable: curl -I ${endpoint}/api/admin/health`;
  }
}

/** Update a release (rollout, mandatory, kill switch) */
export async function updateRelease(
  releaseId: string,
  updates: {
    rollout_percentage?: number;
    is_mandatory?: boolean;
    is_disabled?: boolean;
  },
): Promise<any> {
  const { endpoint, projectId } = resolveAuth();
  if (!projectId) {
    throw new Error('No project selected. Run `sankofa login --deploy-token <token> --project-id <id>` or set SANKOFA_PROJECT_ID.');
  }
  const res = await fetch(`${endpoint}/api/v1/deploy/releases/${releaseId}?projectId=${projectId}`, {
    method: 'PATCH',
    headers: {
      ...getAuthHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });

  if (!res.ok) {
    throw await readAPIError(res, `Update failed (${res.status})`);
  }
  return res.json();
}

export async function getRelease(releaseId: string): Promise<any> {
  const { endpoint, projectId } = resolveAuth();
  if (!projectId) {
    throw new Error('No project selected. Run `sankofa login --deploy-token <token> --project-id <id>` or set SANKOFA_PROJECT_ID.');
  }

  const res = await fetch(`${endpoint}/api/v1/deploy/releases/${releaseId}?projectId=${projectId}`, {
    headers: getAuthHeaders(),
  });

  if (!res.ok) {
    throw await readAPIError(res, `Failed to fetch release (${res.status})`);
  }
  return res.json();
}

// ── Rules / Schedule / Defaults ─────────────────────────────────────

function requireProjectId(): { endpoint: string; projectId: string } {
  const { endpoint, projectId } = resolveAuth();
  if (!projectId) {
    throw new Error('No project selected. Run `sankofa login --deploy-token <token> --project-id <id>`');
  }
  return { endpoint, projectId };
}

async function deployRequest(path: string, opts: FetchOptions = {}): Promise<Response> {
  const { endpoint, projectId } = requireProjectId();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${endpoint}${path}${sep}projectId=${encodeURIComponent(projectId)}`;
  const headers: Record<string, string> = {
    ...getAuthHeaders(),
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  return fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  });
}

export async function getReleaseRule(releaseId: string): Promise<any> {
  const res = await deployRequest(`/api/v1/deploy/releases/${releaseId}/rules`);
  if (!res.ok) throw await readAPIError(res, `Failed to read rule (${res.status})`);
  const data = await res.json();
  return data?.rule ?? null;
}

export async function putReleaseRule(releaseId: string, body: any): Promise<any> {
  const res = await deployRequest(`/api/v1/deploy/releases/${releaseId}/rules`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readAPIError(res, `Failed to save rule (${res.status})`);
  return res.json();
}

export async function deleteReleaseRule(releaseId: string): Promise<void> {
  const res = await deployRequest(`/api/v1/deploy/releases/${releaseId}/rules`, {
    method: 'DELETE',
  });
  if (!res.ok) throw await readAPIError(res, `Failed to clear rule (${res.status})`);
}

export async function getReleaseSchedule(releaseId: string): Promise<any> {
  const res = await deployRequest(`/api/v1/deploy/releases/${releaseId}/schedule`);
  if (!res.ok) throw await readAPIError(res, `Failed to read schedule (${res.status})`);
  const data = await res.json();
  return data?.schedule ?? null;
}

export async function putReleaseSchedule(releaseId: string, body: any): Promise<any> {
  const res = await deployRequest(`/api/v1/deploy/releases/${releaseId}/schedule`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readAPIError(res, `Failed to save schedule (${res.status})`);
  return res.json();
}

export async function scheduleAction(releaseId: string, action: 'pause' | 'resume' | 'promote'): Promise<any> {
  const res = await deployRequest(`/api/v1/deploy/releases/${releaseId}/schedule/${action}`, {
    method: 'POST',
  });
  if (!res.ok) throw await readAPIError(res, `Failed to ${action} schedule (${res.status})`);
  return res.json();
}

export async function getProjectDefaults(env: string): Promise<any> {
  const res = await deployRequest(`/api/v1/deploy/project-defaults?environment=${encodeURIComponent(env)}`);
  if (!res.ok) throw await readAPIError(res, `Failed to read defaults (${res.status})`);
  return res.json();
}

export async function putProjectDefaults(env: string, body: any): Promise<any> {
  const res = await deployRequest(`/api/v1/deploy/project-defaults`, {
    method: 'PUT',
    body: JSON.stringify({ ...body, environment: env }),
  });
  if (!res.ok) throw await readAPIError(res, `Failed to save defaults (${res.status})`);
  return res.json();
}

export async function createDeployToken(
  endpoint: string,
  jwt: string,
  projectId: string,
  name: string,
): Promise<{ token: string; deploy_token: any }> {
  const params = new URLSearchParams({ projectId });
  const res = await fetch(`${endpoint}/api/v1/deploy/tokens?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'x-project-id': projectId,
    },
    body: JSON.stringify({ name, environment: 'all' }),
  });

  if (!res.ok) {
    throw await readAPIError(res, `Failed to create Deploy Token (${res.status})`);
  }
  return res.json();
}
