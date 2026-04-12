/** Global auth config stored in ~/.sankofa/credentials.json */
export interface GlobalConfig {
    apiKey?: string;
    endpoint?: string;
}
/** Per-project config stored in .sankofa.json in the project root */
export interface ProjectConfig {
    projectId?: string;
    apiKey?: string;
    endpoint?: string;
}
export declare function loadGlobalConfig(): GlobalConfig;
export declare function saveGlobalConfig(cfg: GlobalConfig): void;
export declare function findProjectConfig(): ProjectConfig | null;
export declare function saveProjectConfig(cfg: ProjectConfig): void;
/**
 * Resolves the API key and endpoint from (in priority order):
 * 1. SANKOFA_API_KEY / SANKOFA_ENDPOINT env vars
 * 2. .sankofa.json in the project root
 * 3. ~/.sankofa/credentials.json (global login)
 */
export declare function resolveAuth(): {
    apiKey: string;
    endpoint: string;
};
