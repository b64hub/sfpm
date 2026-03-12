import EventEmitter from 'node:events';

import {SourceBuildEvents} from '../../types/events.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import SfpmPackage, {SfpmSourcePackage} from '../sfpm-package.js';
import {
  Builder, BuilderOptions, BuildTask, RegisterBuilder,
} from './builder-registry.js';
import SourceHashTask from './tasks/source-hash-task.js';

// eslint-disable-next-line new-cap
@RegisterBuilder(PackageType.Source)
export default class SourcePackageBuilder extends EventEmitter<SourceBuildEvents> implements Builder {
  public postBuildTasks: BuildTask[] = [];
  public preBuildTasks: BuildTask[] = [];
  private logger?: Logger;
  private options: BuilderOptions;
  private sfpmPackage: SfpmSourcePackage;
  private workingDirectory: string;

  constructor(
    workingDirectory: string,
    sfpmPackage: SfpmPackage,
    options: BuilderOptions,
    logger?: Logger,
  ) {
    super();
    if (!(sfpmPackage instanceof SfpmSourcePackage)) {
      throw new TypeError(`SourcePackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.workingDirectory = workingDirectory;
    this.sfpmPackage = sfpmPackage;
    this.options = options;
    this.logger = logger;

    // Add source hash check to prevent redundant builds
    const projectDir = this.sfpmPackage.projectDirectory;
    this.preBuildTasks.push(new SourceHashTask(this.sfpmPackage, projectDir, this.logger));
  }

  public async connect(username: string): Promise<void> {}

  public async exec(): Promise<void> {
    this.emit('source:assemble:start', {
      packageName: this.sfpmPackage.packageName,
      sourcePath: this.workingDirectory,
      timestamp: new Date(),
    });

    this.handleApexTestClasses(this.sfpmPackage);

    this.emit('source:assemble:complete', {
      artifactPath: this.workingDirectory,
      packageName: this.sfpmPackage.packageName,
      sourcePath: this.workingDirectory,
      timestamp: new Date(),
    });
  }

  private handleApexTestClasses(sfpmPackage: SfpmSourcePackage) {
    if (sfpmPackage.hasApex && sfpmPackage.testClasses.length === 0) {
      sfpmPackage.isTriggerAllTests = true;
    }
  }
}
