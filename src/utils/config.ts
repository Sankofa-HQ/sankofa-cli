import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/** Global auth config stored in ~/.sankofa/credentials.json */
export interface GlobalConfig {
  token?: string;
  authType?: 'deploy_token' | 'jwt';
  apiKey?: string;
  endpoint?: string;
  projectId?: string;
  environment?: 'live' | 'test';
  /**
   * Long-lived session JWT from the browser login, persisted so `sankofa
   * switch` can list projects and mint a new Deploy Token without forcing
   * another browser round-trip. Cleared by `sankofa logout` (any scope that
   * removes the global file) and on JWT expiration.
   */
  sessionJwt?: string;
}

/** Per-project config stored in .sankofa.json in the project root */
export interface ProjectConfig {
  projectId?: string;
  token?: string;
  authType?: 'deploy_token' | 'jwt';
  apiKey?: string;
  endpoint?: string;
  environment?: 'live' | 'test';
}

const GLOBAL_DIR = join(homedir(), '.sankofa');
const GLOBAL_CREDS = join(GLOBAL_DIR, 'credentials.json');
const PROJECT_FILE = '.sankofa.json';

export function loadGlobalConfig(): GlobalConfig {
  try {
    if (existsSync(GLOBAL_CREDS)) {
      return JSON.parse(readFileSync(GLOBAL_CREDS, 'utf-8'));
    }
  } catch {}
  return {};
}

export function saveGlobalConfig(cfg: GlobalConfig): void {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(GLOBAL_CREDS, JSON.stringify(cfg, null, 2));
}

export function findProjectConfig(): ProjectConfig | null {
  // Walk up from cwd looking for .sankofa.json
  let dir = process.cwd();
  while (true) {
    const filePath = join(dir, PROJECT_FILE);
    if (existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        return null;
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function saveProjectConfig(cfg: ProjectConfig): void {
  writeFileSync(join(process.cwd(), PROJECT_FILE), JSON.stringify(cfg, null, 2));
}

/**
 * Resolves deploy management auth from (in priority order):
 * 1. SANKOFA_DEPLOY_TOKEN / SANKOFA_PROJECT_ID / SANKOFA_ENDPOINT env vars
 * 2. .sankofa.json in the project root
 * 3. ~/.sankofa/credentials.json (global login)
 */
export function resolveAuth(): {
  token: string;
  apiKey: string;
  endpoint: string;
  projectId: string;
  authType: 'deploy_token' | 'jwt';
  environment: string;
} {
  const envToken = process.env.SANKOFA_DEPLOY_TOKEN || process.env.SANKOFA_API_KEY;
  const envEndpoint = process.env.SANKOFA_ENDPOINT;
  const envProject = process.env.SANKOFA_PROJECT_ID;
  const envEnvironment = process.env.SANKOFA_ENVIRONMENT;

  const project = findProjectConfig();
  const global = loadGlobalConfig();

  const token = envToken || project?.token || project?.apiKey || global.token || global.apiKey;
  const endpoint = envEndpoint || project?.endpoint || global.endpoint || 'https://api.sankofa.dev';
  const projectId = envProject || project?.projectId || global.projectId || '';
  const environment = envEnvironment || project?.environment || global.environment || 'live';
  const authType =
    (envToken?.startsWith('sk_deploy_') ? 'deploy_token' : undefined) ||
    project?.authType ||
    global.authType ||
    (token?.startsWith('sk_deploy_') ? 'deploy_token' : 'jwt');

  if (!token) {
    throw new Error(
      'No Deploy Token found. Run `sankofa login --deploy-token <token> --project-id <id>` or set SANKOFA_DEPLOY_TOKEN.',
    );
  }

  return { token, apiKey: token, endpoint, projectId, authType, environment };
}

/**
 * Check upfront whether the CLI has any credentials at all. Use this at the
 * START of every authenticated command so we don't prompt for environment,
 * platform, etc. only to fail with "No Deploy Token found" at the first API
 * call.
 */
export async function requireAuth(): Promise<void> {
  try {
    resolveAuth();
  } catch (err: any) {
    const chalk = (await import('chalk')).default;
    console.error(chalk.red('  You are not logged in.'));
    console.error('');
    console.error(chalk.dim('  Run `sankofa login` to authenticate.'));
    process.exit(1);
  }
}
