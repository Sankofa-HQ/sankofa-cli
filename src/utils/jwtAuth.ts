import { loadGlobalConfig } from './config.js';

/**
 * Resolved dashboard-auth bundle used by the CLI for routes that live
 * under JWT auth (Switch, Config, Audit). Unlike Deploy's management
 * endpoints — which accept both Deploy Tokens and JWTs — Switch and
 * Config endpoints use the shared dashboard auth middleware directly,
 * so only a real JWT gets in.
 *
 * Priority:
 *   1. SANKOFA_JWT env var (CI / script use)
 *   2. sessionJwt stored by `sankofa login` (browser flow)
 *   3. Fall through with a friendly error if neither exists
 */
export interface JWTAuth {
  jwt: string;
  endpoint: string;
  projectId: string;
  environment: 'live' | 'test';
}

export function resolveJWT(): JWTAuth {
  const envJwt = process.env.SANKOFA_JWT;
  const envEndpoint = process.env.SANKOFA_ENDPOINT;
  const envProject = process.env.SANKOFA_PROJECT_ID;
  const envEnvironment = process.env.SANKOFA_ENVIRONMENT;

  const global = loadGlobalConfig();
  const jwt = envJwt || global.sessionJwt;
  const endpoint = envEndpoint || global.endpoint || 'https://api.sankofa.dev';
  const projectId = envProject || global.projectId || '';
  const environment = (envEnvironment || global.environment || 'live') as 'live' | 'test';

  if (!jwt) {
    throw new Error(
      'No dashboard session found. Run `sankofa login` to store a session, ' +
      'or set SANKOFA_JWT for CI use.',
    );
  }
  if (!projectId) {
    throw new Error('No project selected. Run `sankofa switch` to pick a project.');
  }

  // Proactive local expiry check so we surface a clean "session expired"
  // message instead of the server's generic "Invalid token" — the jwt
  // library intentionally collapses expired + signature-bad into the
  // same error. Local decode is safe: we verify nothing cryptographically
  // here (the server still validates on every request), we just read
  // the exp claim to front-load a better UX.
  const exp = safeDecodeExp(jwt);
  if (exp !== null && exp * 1000 < Date.now()) {
    throw new Error(
      'Your session has expired. Run `sankofa login` to refresh.',
    );
  }

  return { jwt, endpoint, projectId, environment };
}

/**
 * Extract the `exp` claim from a JWT without verifying the signature.
 * Returns null when the token doesn't parse as a JWT at all — in that
 * case we treat expiry as "unknown" and let the server decide.
 *
 * We deliberately don't verify the signature here: that's the server's
 * job, and signature verification would require shipping the signing
 * secret to the CLI (worse security posture).
 */
function safeDecodeExp(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Fetch wrapper that carries the JWT and project-id header expected by
 * Switch / Config / Audit endpoints. Returns the parsed JSON body on
 * 2xx; throws an Error with the server's error message on anything
 * else so callers can bubble a clean message to the terminal.
 */
export async function jwtFetch<T = unknown>(
  auth: JWTAuth,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${auth.endpoint.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${auth.jwt}`,
    'x-project-id': auth.projectId,
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    // The server returns "Invalid token" for expired + bad-sig + bad-
    // shape JWTs alike. All three have the same user-facing fix, so we
    // collapse them into a single actionable message.
    if (res.status === 401) {
      throw new Error(
        'Your session is no longer valid. Run `sankofa login` to refresh.',
      );
    }
    const message = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}
