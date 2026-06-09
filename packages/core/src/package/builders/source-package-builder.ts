import { Org } from '@salesforce/core';
import type {BuildEventSink} from '../../events/build-event-bus.js';

import {MetadataDeployService} from '../../tooling/metadata-deploy-service.js';
import {BuildError} from '../../types/errors.js';
import {Logger} from '../../types/logger.js';
import {PackageType, PendingValidationDescriptor, type ValidationCheck} from '../../types/package.js';
import SfpmPackage, {SfpmMetadataPackage, SfpmSourcePackage} from '../sfpm-package.js';
import {
  Builder, BuilderOptions, BuildTaskRegistration, RegisterBuilder,
} from './builder-registry.js';
import {assembleArtifactTask} from './tasks/assemble-artifact-task.js';
import {dependencyAnalysisTask} from './tasks/dependency-analysis-task.js';


const VALIDATION_TEST_LEVEL = 'RunSpecifiedTests';

// eslint-disable-next-line new-cap
@RegisterBuilder(PackageType.Source)
export default class SourcePackageBuilder implements Builder {
  public tasks: BuildTaskRegistration[] = [];
  private buildOrg?: Org;
  private logger?: Logger;
  private options: BuilderOptions;
  private sfpmPackage: SfpmMetadataPackage;
  private sink?: BuildEventSink;
  private workingDirectory: string;

  constructor(
    workingDirectory: string,
    sfpmPackage: SfpmPackage,
    options: BuilderOptions,
    logger?: Logger,
    sink?: BuildEventSink,
  ) {
    if (!(sfpmPackage instanceof SfpmMetadataPackage)) {
      throw new TypeError(`SourcePackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.workingDirectory = workingDirectory;
    this.sfpmPackage = sfpmPackage;
    this.options = options;
    this.logger = logger;
    this.sink = sink;

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

    // Post-build: assemble artifact (conditional on mode)
    if (options.artifact !== false) {
      this.tasks.push({factory: assembleArtifactTask(), phase: 'post'});
    }
  }

  public async connect(username: string): Promise<void> {
    if (!username && this.options.validation === true) {
      throw new BuildError(this.sfpmPackage.packageName, 'Validation is enabled but no build org username was provided', {
        buildStep: 'connect',
      });
    }

    try {
      this.buildOrg = await Org.create({aliasOrUsername: username});
    } catch (err) {
      this.logger?.error(`Failed to connect to org '${username}': ${(err as Error).message}`);
      throw new BuildError(this.sfpmPackage.packageName, `Connection failed for org '${username}'`, {
        buildStep: 'connect',
        cause: err as Error,
      });
    }
  }

  public async exec(): Promise<void> {
    this.sink?.assembleStart({
      sourcePath: this.workingDirectory,
    });

    this.handleApexTestClasses(this.sfpmPackage);

    this.sink?.assembleComplete({
      artifactPath: this.workingDirectory,
      sourcePath: this.workingDirectory,
    });
  }

  /**
   * Initiate validation by deploying metadata with tests against the build org.
   *
   * Returns a {@link PendingValidationDescriptor} that the caller can resolve
   * (via ValidationResolver) when ready. Sets the domain model to pending state.
   *
   * Skipped (returns undefined) when:
   * - Validation is disabled (`options.validation === false`)
   * - No build org is available
   * - Package has no Apex (nothing to validate)
   */
  public async validate(): Promise<PendingValidationDescriptor | undefined> {
    const targetOrg = this.buildOrg;

    if (this.options.validation === false || !targetOrg) return undefined;

    const testClasses = this.getTestClasses();
    if (this.sfpmPackage.hasApex && testClasses.length === 0) {
      throw new BuildError(this.sfpmPackage.packageName, 'Package contains Apex but has no test classes defined', {
        buildStep: 'validation',
      });
    }

    this.logger?.info(`Validating '${this.sfpmPackage.packageName}' against ${targetOrg} [deploy+test]`);
    this.logger?.info(`Running ${testClasses.length} test class(es): ${testClasses.join(', ')}`);

    this.sink?.taskValidateStart({
      testCount: testClasses.length,
      testLevel: VALIDATION_TEST_LEVEL,
    });

    const deployService = new MetadataDeployService(this.logger);

    // Deploy metadata with specified tests
    const componentSet = this.sfpmPackage.getComponentSet();
    const deployId = await deployService.deploy(componentSet, targetOrg.getConnection(), {
      testClasses,
      testLevel: VALIDATION_TEST_LEVEL,
    });

    // Set pending state on domain model
    const descriptor: PendingValidationDescriptor = {
      operationId: deployId,
      operationType: 'deploy',
      packageName: this.sfpmPackage.packageName,
      startedAt: new Date().toISOString(),
      targetOrg: targetOrg.getUsername() as string,
    };

    this.sfpmPackage.validationState = {
      checks: ['deploy', 'test'] as ValidationCheck[],
      pending: descriptor,
      status: 'pending',
    };

    return descriptor;
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

