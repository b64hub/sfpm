import Git from '../../../git/git.js';
import {Logger} from '../../../types/logger.js';
import {toVersionFormat} from '../../../utils/version-utils.js';
import SfpmPackage from '../../sfpm-package.js';
import {BuildTask, BuildTaskContext, BuildTaskResult} from '../builder-registry.js';

/**
 * @deprecated git tagging is no longer part of build
 * Kept for future reference when implementing publish
 */
class GitTagTask implements BuildTask {
  public readonly name = 'git-tag';
  private readonly logger?: Logger;
  private readonly sfpmPackage: SfpmPackage;

  public constructor(ctx: BuildTaskContext) {
    this.sfpmPackage = ctx.sfpmPackage;
    this.logger = ctx.logger;
  }

  public async exec(): Promise<BuildTaskResult | void> {
    const normalizedVersion = toVersionFormat(this.sfpmPackage.version || '0.0.0.1', 'semver');
    const tagname = `${this.sfpmPackage.packageName}@${normalizedVersion}`;

    this.logger?.info(`Tagging package ${this.sfpmPackage.packageName} with ${tagname}`);

    const git = await Git.initiateRepo(this.logger);
    await git.addAnnotatedTag(
      tagname,
      `${this.sfpmPackage.packageName} sfpm package ${normalizedVersion}`,
    );

    this.logger?.info(`Successfully tagged ${this.sfpmPackage.packageName} as ${tagname}`);

    return undefined;
  }
}

/** Factory for GitTagTask — no task-specific options needed. */
export function gitTagTask(): (ctx: BuildTaskContext) => BuildTask {
  return (ctx: BuildTaskContext) => new GitTagTask(ctx);
}

export default GitTagTask;
