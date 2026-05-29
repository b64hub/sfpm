import EventEmitter from 'node:events';

import {SourceBuildEvents} from '../../types/events.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import SfpmPackage, {SfpmMetadataPackage, SfpmSourcePackage} from '../sfpm-package.js';
import {
  Builder, BuilderOptions, BuildTaskRegistration, RegisterBuilder,
} from './builder-registry.js';
import {assembleArtifactTask} from './tasks/assemble-artifact-task.js';
import {dependencyAnalysisTask} from './tasks/dependency-analysis-task.js';
import {gitTagTask} from './tasks/git-tag-task.js';
import {sourceHashTask} from './tasks/source-hash-task.js';
import {validationTask} from './tasks/validation-task.js';

// eslint-disable-next-line new-cap
@RegisterBuilder(PackageType.Source)
export default class SourcePackageBuilder extends EventEmitter<SourceBuildEvents> implements Builder {
  public tasks: BuildTaskRegistration[] = [];
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

    // Pre-build: source hash check to prevent redundant builds
    this.tasks.push({factory: sourceHashTask(), phase: 'pre'});

    // Pre-build: static dependency analysis when an analyzer is provided
    if (options.dependencyAnalysis?.dependencyAnalyzer) {
      this.tasks.push({
        factory: dependencyAnalysisTask({
          analyzer: options.dependencyAnalysis.dependencyAnalyzer,
          warnOnly: options.dependencyAnalysis.warnOnly,
        }),
        phase: 'pre',
      });
    }

    // Post-build: validation when enabled and a build org is available
    if (options.validation !== false && options.buildOrg) {
      this.tasks.push({factory: validationTask({validationOrg: options.buildOrg}), phase: 'post'});
    }

    // Post-build: assemble artifact (conditional on mode)
    if (options.artifact !== false) {
      this.tasks.push({factory: assembleArtifactTask(), phase: 'post'});
    }

    // Post-build: git tag (conditional on mode)
    if (options.gitTag !== false) {
      this.tasks.push({factory: gitTagTask(), phase: 'post'});
    }
  }

  public async connect(username: string): Promise<void> {
    this.buildOrg = username;

    // If validation was deferred (buildOrg provided at connect-time, not constructor-time),
    // insert the validation task before the assemble task
    if (this.options.validation !== false && !this.options.buildOrg && username) {
      const assembleIdx = this.tasks.findIndex(t => t.phase === 'post' && t.factory.toString().includes('AssembleArtifactTask'));

      const registration: BuildTaskRegistration = {
        factory: validationTask({validationOrg: username}),
        phase: 'post',
      };

      if (assembleIdx === -1) {
        this.tasks.push(registration);
      } else {
        this.tasks.splice(assembleIdx, 0, registration);
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
