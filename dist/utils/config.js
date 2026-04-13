import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
const GLOBAL_DIR = join(homedir(), '.sankofa');
const GLOBAL_CREDS = join(GLOBAL_DIR, 'credentials.json');
const PROJECT_FILE = '.sankofa.json';
export function loadGlobalConfig() {
    try {
        if (existsSync(GLOBAL_CREDS)) {
            return JSON.parse(readFileSync(GLOBAL_CREDS, 'utf-8'));
        }
    }
    catch { }
    return {};
}
export function saveGlobalConfig(cfg) {
    mkdirSync(GLOBAL_DIR, { recursive: true });
    writeFileSync(GLOBAL_CREDS, JSON.stringify(cfg, null, 2));
}
export function findProjectConfig() {
    // Walk up from cwd looking for .sankofa.json
    let dir = process.cwd();
    while (true) {
        const filePath = join(dir, PROJECT_FILE);
        if (existsSync(filePath)) {
            try {
                return JSON.parse(readFileSync(filePath, 'utf-8'));
            }
            catch {
                return null;
            }
        }
        const parent = resolve(dir, '..');
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
export function saveProjectConfig(cfg) {
    writeFileSync(join(process.cwd(), PROJECT_FILE), JSON.stringify(cfg, null, 2));
}
/**
 * Resolves the API key and endpoint from (in priority order):
 * 1. SANKOFA_API_KEY / SANKOFA_ENDPOINT env vars
 * 2. .sankofa.json in the project root
 * 3. ~/.sankofa/credentials.json (global login)
 */
export function resolveAuth() {
    const envKey = process.env.SANKOFA_API_KEY;
    const envEndpoint = process.env.SANKOFA_ENDPOINT;
    const envProject = process.env.SANKOFA_PROJECT_ID;
    const project = findProjectConfig();
    const global = loadGlobalConfig();
    const apiKey = envKey || project?.apiKey || global.apiKey;
    const endpoint = envEndpoint || project?.endpoint || global.endpoint || 'https://api.sankofa.dev';
    const projectId = envProject || project?.projectId || global.projectId || '';
    if (!apiKey) {
        throw new Error('No API key found. Run `sankofa login` or set SANKOFA_API_KEY env var.');
    }
    return { apiKey, endpoint, projectId };
}
//# sourceMappingURL=config.js.map