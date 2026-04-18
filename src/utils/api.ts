import { statSync, openAsBlob } from 'fs';
import { resolveAuth } from './config.js';
import { normalizeEnvironment, normalizePlatform } from './validation.js';

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

async function readAPIError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as any;
  const message = body?.error || body?.message || fallback;
  return new Error(message);
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
  const bundleBlob = await openAsBlob(bundlePath, { type: 'application/zip' });
  form.append('bundle', bundleBlob, 'ota.zip');
  form.append('bundle_format', 'zip');
  if (metadata.native_artifact_path) {
    const nativeBlob = await openAsBlob(metadata.native_artifact_path, {
      type: 'application/octet-stream',
    });
    form.append('native_artifact', nativeBlob, metadata.native_artifact_path.split('/').pop() || 'native-artifact');
    form.append('native_artifact_kind', metadata.native_artifact_kind || '');
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
    // metadata). Node's fetch defaults to a 5-minute headers timeout,
    // which trips on slow networks + cold storage. Bump to 20 min.
    //
    // `dispatcher` is the undici Agent used under the hood — it's
    // accepted by Node's fetch even though it's not in the standard
    // Fetch API types. Import is dynamic because undici is a Node
    // built-in (not available in non-Node runtimes) but bundlers may
    // complain about a static import.
    // @ts-ignore — undici ships with Node >= 18 but isn't in @types/node as
    // an importable module path. Dynamic import resolves at runtime.
    const undici = await import('undici' as any) as any;
    const longUploadAgent = new undici.Agent({
      headersTimeout: 20 * 60 * 1000,
      bodyTimeout: 20 * 60 * 1000,
      connectTimeout: 30 * 1000,
    });
    res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
      },
      body: form,
      dispatcher: longUploadAgent,
    } as any);
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
