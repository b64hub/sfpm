/**
 * Represents the manifest.json structure for package artifacts.
 * This manifest tracks all versions of a package and their associated metadata.
 */
export interface ArtifactManifest {
    name: string;
    latest: string;
    versions: {
        [version: string]: {
            path: string;
            hash?: string;
            sourceHash?: string;
            artifactHash?: string;
            generatedAt: number;
            commit?: string;
        }
    };
}
