import { readFileSync, statSync } from 'fs';
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
  const bundleBytes = readFileSync(bundlePath);
  const bundleBlob = new Blob([new Uint8Array(bundleBytes)], { type: 'application/zip' });
  form.append('bundle', bundleBlob, 'ota.zip');
  form.append('bundle_format', 'zip');
  if (metadata.native_artifact_path) {
    const nativeBytes = readFileSync(metadata.native_artifact_path);
    const nativeBlob = new Blob([new Uint8Array(nativeBytes)], { type: 'application/octet-stream' });
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

  const res = await fetch(`${endpoint}/api/v1/deploy/releases?projectId=${projectId}`, {
    method: 'POST',
    headers: {
      ...getAuthHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    throw await readAPIError(res, `Upload failed (${res.status})`);
  }

  return res.json();
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
