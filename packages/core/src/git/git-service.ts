import Git from './git.js';
import { SfpmPackageSource } from '../types/package.js';
import { Logger } from '../types/logger.js';

/**
 * Domain-level service for Git operations in SFPM context.
 * Provides high-level orchestration and adaptation to SFPM domain models.
 * For low-level git operations, use getGit() to access the underlying Git instance.
 */
export class GitService {
    private git: Git;
    private logger?: Logger;

    constructor(git: Git, logger?: Logger) {
        this.git = git;
        this.logger = logger;
    }

    /**
     * Factory method to initialize a GitService for a project directory
     */
    static async initialize(projectDir?: string, logger?: Logger): Promise<GitService> {
        const git = await Git.initiateRepo(logger, projectDir);
        return new GitService(git, logger);
    }

    /**
     * Factory method to create a GitService with a temporary repository
     */
    static async createTemporaryRepository(
        logger: Logger,
        commitRef?: string,
        branch?: string
    ): Promise<GitService> {
        const git = await Git.initiateRepoAtTempLocation(logger, commitRef, branch);
        return new GitService(git, logger);
    }

    /**
     * Get the package source context for metadata.
     * Orchestrates multiple git operations to build the SFPM domain model.
     */
    async getPackageSourceContext(): Promise<SfpmPackageSource> {
        const commitSHA = await this.git.getCurrentCommitId();
        const repositoryUrl = await this.git.getRemoteOriginUrl();
        const branch = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

        return {
            repositoryUrl,
            branch,
            commitSHA,
        };
    }

    /**
     * Get the underlying Git instance for low-level operations
     */
    getGit(): Git {
        return this.git;
    }
}
