import {Org} from '@salesforce/core';
import path from 'node:path';

import type {BuildEventSink} from '../../events/build-event-bus.js';
import type {ProjectDefinitionProvider} from '../../project/providers/project-definition-provider.js';

import Logger from '../../types/logger.js';
import {BuildOptions, PackageType} from '../../types/package.js';
import {
  DeployValidationDescriptor, type ValidationCheck,
} from '../../types/validation.js'
import SfpmPackage, {SfpmMetadataPackage, SfpmSourcePackage} from '../sfpm-package.js';
import {
  Builder, BuilderResult, BuildTaskRegistration, RegisterBuilder,
} from './builder-registry.js';
import {assembleArtifactTask} from './tasks/assemble-artifact-task.js';

const VALIDATION_TEST_LEVEL = 'RunSpecifiedTests';

// eslint-disable-next-line new-cap
@RegisterBuilder(PackageType.Source)
export default class SourcePackageBuilder implements Builder {
  public tasks: BuildTaskRegistration[] = [];
  private buildOrg?: Org;
  private logger?: Logger;
  private options: BuildOptions;
  private provider: ProjectDefinitionProvider;
  private sfpmPackage: SfpmMetadataPackage;
  private sink?: BuildEventSink;
  private workingDirectory: string;

  constructor(
    provider: ProjectDefinitionProvider,
    sfpmPackage: SfpmPackage,
    options: BuildOptions,
    logger?: Logger,
    sink?: BuildEventSink,
  ) {
    if (!(sfpmPackage instanceof SfpmMetadataPackage)) {
      throw new TypeError(`SourcePackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.provider = provider;
    this.workingDirectory = provider.getPackageBuildDirectory(sfpmPackage.name)!;
    this.sfpmPackage = sfpmPackage;
    this.options = options;
    this.logger = logger;
    this.sink = sink;

    // Post-build: assemble artifact metadata (package.json, manifest)
    this.tasks.push({factory: assembleArtifactTask(), phase: 'post'});
  }

  public async connect(buildOrg: Org | undefined): Promise<void> {
    this.buildOrg = buildOrg;
  }

  public async exec(): Promise<BuilderResult> {
    this.sink?.assembleStart({
      sourcePath: this.workingDirectory,
    });

    // Ensure content analysis is done (no-op if build already ran analyzers)
    await this.sfpmPackage.ensureAnalyzed(this.provider);

    this.handleApexTestClasses(this.sfpmPackage);

    this.sink?.assembleComplete({
      artifactPath: this.workingDirectory,
      sourcePath: this.workingDirectory,
    });

    const validationDescriptor = this.buildValidationDescriptor();

    return {
      packageName: this.sfpmPackage.name,
      packageType: PackageType.Source,
      pendingValidation: validationDescriptor,
      version: this.sfpmPackage.version as string,
    };
  }

  /**
   * Construct validation descriptor for validation to be done
   *
   * - If validation ran (pendingValidation returned) a deploy check queued.
   * - If validation was skipped (no org, disabled, or no Apex), no state is set.
   */
  private buildValidationDescriptor(): DeployValidationDescriptor | undefined {
    const targetOrg = this.buildOrg;

    if (!this.options.validation || this.options.validation === 'none') return undefined;
    if (!targetOrg) {
      this.logger?.warn(`No build org defined for ${this.sfpmPackage.name}. Skipping validaiton.`);
      return undefined
    }

    const testLevel = this.getTestClasses().length > 0 ? VALIDATION_TEST_LEVEL : 'NoTestRun';

    return {
      operationType: 'deploy',
      packageName: this.sfpmPackage.packageName,
      targetOrg: targetOrg?.getUsername() as string,
      testLevel,
    };
  }

  private getTestClasses(): string[] {
    return this.sfpmPackage.testClasses.map(tc => (typeof tc === 'string' ? tc : tc.name));
  }

  private handleApexTestClasses(sfpmPackage: SfpmMetadataPackage) {
    if (sfpmPackage instanceof SfpmSourcePackage && sfpmPackage.hasApex && sfpmPackage.testClasses.length === 0) {
      sfpmPackage.testLevel = 'RunLocalTests';
    }
  }
}
