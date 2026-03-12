import Git from '../../../git/git.js';
import {Logger} from '../../../types/logger.js';
import {toVersionFormat} from '../../../utils/version-utils.js';
import SfpmPackage from '../../sfpm-package.js';
import {BuildTask} from '../builder-registry.js';

export default class GitTagTask implements BuildTask {
  public constructor(
    private sfpmPackage: SfpmPackage,
    private artifactDirectory: string,
    private logger?: Logger,
  ) { }

  public async exec(): Promise<void> {
    const normalizedVersion = toVersionFormat(this.sfpmPackage.version || '0.0.0.1', 'semver');
    const tagname = `${this.sfpmPackage.packageName}@${normalizedVersion}`;

    this.logger?.info(`Tagging package ${this.sfpmPackage.packageName} with ${tagname}`);

    const git = await Git.initiateRepo(this.logger);
    await git.addAnnotatedTag(
      tagname,
      `${this.sfpmPackage.packageName} sfpm package ${normalizedVersion}`,
    );

    this.sfpmPackage.metadata.source.tag = tagname;
    this.logger?.info(`Successfully tagged ${this.sfpmPackage.packageName} as ${tagname}`);
  }
}
