import EventEmitter from 'node:events';

import {SourceBuildEvents} from '../../types/events.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import SfpmPackage, {SfpmMetadataPackage, SfpmSourcePackage} from '../sfpm-package.js';
import {
  Builder, BuilderOptions, BuildTask, RegisterBuilder,
} from './builder-registry.js';
import AssembleArtifactTask from './tasks/assemble-artifact-task.js';
import SourceHashTask from './tasks/source-hash-task.js';
import ValidationTask from './tasks/validation-task.js';

// eslint-disable-next-line new-cap
@RegisterBuilder(PackageType.Source)
export default class SourcePackageBuilder extends EventEmitter<SourceBuildEvents> implements Builder {
  public postBuildTasks: BuildTask[] = [];
  public preBuildTasks: BuildTask[] = [];
  private buildOrg?: string;
  private logger?: Logger;
  private options: BuilderOptions;
  private sfpmPackage: SfpmMetadataPackage;
  private workingDirectory: string;

  constructor(
    workingDirectory: string,
    sfpmPackage: SfpmPackage,
    options: BuilderOptions,
    logger?: Logger,
  ) {
    super();
    if (!(sfpmPackage instanceof SfpmMetadataPackage)) {
      throw new TypeError(`SourcePackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.workingDirectory = workingDirectory;
    this.sfpmPackage = sfpmPackage;
    this.options = options;
    this.logger = logger;

    // Add source hash check to prevent redundant builds
    const projectDir = this.sfpmPackage.projectDirectory;
    this.preBuildTasks.push(new SourceHashTask(this.sfpmPackage, projectDir, this.logger));

    // Add validation task when not skipped and a build org is available
    if (!options.skipValidation && options.buildOrg) {
      this.postBuildTasks.push(new ValidationTask(this.sfpmPackage, options.buildOrg, this.logger, this));
    }

    // Assemble artifact after build so source packages are installable via artifact resolution
    this.postBuildTasks.push(new AssembleArtifactTask(this.sfpmPackage, projectDir, {}));
  }

  public async connect(username: string): Promise<void> {
    this.buildOrg = username;

    // If validation was deferred (buildOrg provided at connect-time, not constructor-time),
    // insert the ValidationTask before AssembleArtifactTask
    if (!this.options.skipValidation && !this.options.buildOrg && username) {
      const assembleIdx = this.postBuildTasks.findIndex(t => t instanceof AssembleArtifactTask);
      const validationTask = new ValidationTask(this.sfpmPackage, username, this.logger, this);
      if (assembleIdx === -1) {
        this.postBuildTasks.push(validationTask);
      } else {
        this.postBuildTasks.splice(assembleIdx, 0, validationTask);
      }
    }
  }

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

  private handleApexTestClasses(sfpmPackage: SfpmMetadataPackage) {
    if (sfpmPackage instanceof SfpmSourcePackage && sfpmPackage.hasApex && sfpmPackage.testClasses.length === 0) {
      sfpmPackage.testLevel = 'RunLocalTests';
    }
  }
}
