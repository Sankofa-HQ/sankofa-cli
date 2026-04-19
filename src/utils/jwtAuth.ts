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
      'No dashboard session found. Run `sankofa login` (the browser flow) ' +
      'to store a session JWT, or set SANKOFA_JWT for CI use.',
    );
  }
  if (!projectId) {
    throw new Error('No project selected. Run `sankofa switch` to pick a project.');
  }

  return { jwt, endpoint, projectId, environment };
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
    const message = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}
