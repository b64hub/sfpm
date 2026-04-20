import fs from 'fs-extra';
import ignore from 'ignore';
import path from 'node:path';
import tmp from 'tmp';

import {Logger} from '../types/logger.js';
import {SfpmPackageSource} from '../types/package.js';
import Git from './git.js';

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
   * Factory method to create a GitService with a temporary repository.
   * Orchestrates the complex workflow of creating a temp repo with specific commit/branch.
   */
  static async createTemporaryRepository(
    logger: Logger,
    commitRef?: string,
    branch?: string,
  ): Promise<GitService> {
    const locationOfCopiedDirectory = tmp.dirSync({unsafeCleanup: true});

    logger.info(`Copying the repository to ${locationOfCopiedDirectory.name}`);
    const repoDir = locationOfCopiedDirectory.name;

    // Copy source directory to temp dir respecting .gitignore
    const gitignore = ignore();
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = fs.readFileSync(gitignorePath).toString();
      gitignore.add(gitignoreContent);
    }

    fs.copySync(process.cwd(), repoDir, {
      filter(src) {
        const relativePath = path.relative(process.cwd(), src);

        // Always include root directory
        if (!relativePath) {
          return true;
        }

        // Check if file should be ignored
        return !gitignore.ignores(relativePath);
      },
    });

    // Initialize git on new repo
    const git = new Git(repoDir, logger);
    (git as unknown as Record<string, unknown>)._isATemporaryRepo = true;
    (git as unknown as Record<string, unknown>).tempRepoLocation = locationOfCopiedDirectory;

    await git.addSafeConfig(repoDir);
    await git.getRemoteOriginUrl();
    await git.fetch();
    if (branch) {
      await git.createBranch(branch);
    }

    if (commitRef) {
      await git.checkout(commitRef, true);
    }

    logger.info(`Successfully created temporary repository at ${repoDir} with commit ${commitRef || 'HEAD'}`);

    return new GitService(git, logger);
  }

  /**
   * Factory method to initialize a GitService for a project directory
   */
  static async initialize(projectDir?: string, logger?: Logger): Promise<GitService> {
    const git = await Git.initiateRepo(logger, projectDir);
    return new GitService(git, logger);
  }

  /**
   * Returns which package paths have changed files between `baseRef` and HEAD.
   *
   * Uses a three-dot diff (`baseRef...HEAD`) to compare only the diverged
   * commits, then matches the changed file paths against the supplied package
   * directory paths.
   *
   * @param baseRef      - Git ref to compare against (branch, tag, or SHA)
   * @param packagePaths - Package directory paths relative to the project root
   * @returns The subset of `packagePaths` that contain at least one changed file
   */
  async getChangedPackagePaths(baseRef: string, packagePaths: string[]): Promise<string[]> {
    const repoRoot = (await this.git.raw(['rev-parse', '--show-toplevel'])).trim();
    const projectRoot = this.git.getRepositoryPath();

    const changedFiles = await this.git.diff(['--name-only', `${baseRef}...HEAD`]);

    if (changedFiles.length === 0) return [];

    return packagePaths.filter(pkgPath => {
      const absolutePkgPath = path.resolve(projectRoot, pkgPath);
      const relativePkgPath = path.relative(repoRoot, absolutePkgPath);

      // Git always uses forward-slashes
      const normalized = relativePkgPath.split(path.sep).join('/');

      return changedFiles.some(file =>
        file.startsWith(normalized + '/') || file === normalized);
    });
  }

  /**
   * Get the underlying Git instance for low-level operations
   */
  getGit(): Git {
    return this.git;
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
      branch,
      commit: commitSHA,
      repositoryUrl,
    };
  }
}
