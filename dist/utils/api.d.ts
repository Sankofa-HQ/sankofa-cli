/** List releases for the current project */
export declare function listReleases(env?: string, platform?: string): Promise<any[]>;
/** Upload a bundle to the server */
export declare function uploadRelease(bundlePath: string, metadata: {
    label: string;
    target_binary_version: string;
    platform: string;
    description?: string;
    is_mandatory?: boolean;
    rollout_percentage?: number;
    environment?: string;
}, onProgress?: (uploaded: number, total: number) => void): Promise<any>;
/** Update a release (rollout, mandatory, kill switch) */
export declare function updateRelease(releaseId: string, updates: {
    rollout_percentage?: number;
    is_mandatory?: boolean;
    is_disabled?: boolean;
}): Promise<any>;
