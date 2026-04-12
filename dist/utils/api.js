import { createReadStream, statSync } from 'fs';
import { resolveAuth } from './config.js';
async function apiFetch(path, opts = {}) {
    const { apiKey, endpoint } = resolveAuth();
    const url = `${endpoint}${path}`;
    const headers = {
        'x-api-key': apiKey,
        ...opts.headers,
    };
    // Use global fetch (Node 18+)
    return fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body,
    });
}
/** List releases for the current project */
export async function listReleases(env = 'live', platform) {
    const { apiKey, endpoint } = resolveAuth();
    const params = new URLSearchParams({ environment: env });
    if (platform)
        params.set('platform', platform);
    // Dashboard API uses JWT but CLI uses API key → use the SDK-facing approach
    // We query via the dashboard API with the API key as bearer token
    const res = await fetch(`${endpoint}/api/v1/deploy/releases?${params}`, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'x-api-key': apiKey,
        },
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to list releases (${res.status})`);
    }
    return res.json();
}
/** Upload a bundle to the server */
export async function uploadRelease(bundlePath, metadata, onProgress) {
    const { apiKey, endpoint } = resolveAuth();
    const stats = statSync(bundlePath);
    const totalSize = stats.size;
    // Use FormData with the bundle file
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('bundle', createReadStream(bundlePath), {
        filename: 'bundle.jsbundle',
        contentType: 'application/javascript',
    });
    form.append('metadata', JSON.stringify({
        ...metadata,
        environment: metadata.environment || 'live',
        rollout_percentage: metadata.rollout_percentage ?? 100,
    }));
    const res = await fetch(`${endpoint}/api/v1/deploy/releases`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'x-api-key': apiKey,
            ...form.getHeaders(),
        },
        body: form,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed (${res.status})`);
    }
    return res.json();
}
/** Update a release (rollout, mandatory, kill switch) */
export async function updateRelease(releaseId, updates) {
    const { apiKey, endpoint } = resolveAuth();
    const res = await fetch(`${endpoint}/api/v1/deploy/releases/${releaseId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Update failed (${res.status})`);
    }
    return res.json();
}
//# sourceMappingURL=api.js.map