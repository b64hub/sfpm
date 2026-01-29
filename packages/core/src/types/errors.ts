/**
 * Custom error thrown when no source changes are detected
 * This is not a failure - it's a successful early exit
 */
export class NoSourceChangesError extends Error {
    public readonly latestVersion: string;
    public readonly sourceHash: string;
    public readonly artifactPath?: string;

    constructor(data: {
        latestVersion: string;
        sourceHash: string;
        artifactPath?: string;
        message?: string;
    }) {
        super(data.message || 'No source changes detected');
        this.name = 'NoSourceChangesError';
        this.latestVersion = data.latestVersion;
        this.sourceHash = data.sourceHash;
        this.artifactPath = data.artifactPath;

        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, NoSourceChangesError);
        }
    }
}
