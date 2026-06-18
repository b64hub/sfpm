import {Org} from '@salesforce/core';
import path from 'node:path';

import type {BuildEventSink} from '../../events/build-event-bus.js';

import {MetadataDeployService} from '../../tooling/metadata-deploy-service.js';
import {BuildError} from '../../types/errors.js';
import {Logger} from '../../types/logger.js';
import {PackageType, PendingValidationDescriptor, type ValidationCheck} from '../../types/package.js';
import SfpmPackage, {SfpmMetadataPackage, SfpmSourcePackage} from '../sfpm-package.js';
import {
  Builder, BuilderOptions, BuilderResult, BuildTaskRegistration, RegisterBuilder,
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

    // Post-build: assemble artifact metadata (package.json, manifest)
    this.tasks.push({factory: assembleArtifactTask(), phase: 'post'});
  }

  public async connect(targetOrg: Org): Promise<void> {
    this.buildOrg = targetOrg;
  }

  public async exec(): Promise<BuilderResult> {
    this.sink?.assembleStart({
      sourcePath: this.workingDirectory,
    });

    // Ensure content analysis is done (no-op if build already ran analyzers)
    await this.sfpmPackage.ensureAnalyzed();

    this.handleApexTestClasses(this.sfpmPackage);

    this.sink?.assembleComplete({
      artifactPath: this.workingDirectory,
      sourcePath: this.workingDirectory,
    });

    // Validate if enabled and an org is available
    const pendingValidation = await this.validate();

    return {
      pendingValidation,
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

  /**
   * Initiate validation by deploying metadata with tests against the build org.
   *
   * Skipped (returns undefined) when:
   * - Validation is disabled (`options.validation === false`)
   * - No build org is available
   * - Package has no Apex (nothing to validate)
   */
  private async validate(): Promise<PendingValidationDescriptor | undefined> {
    const targetOrg = this.buildOrg;

    if (this.options.validation === false || !targetOrg) return undefined;

    const testClasses = this.getTestClasses();
    if (this.sfpmPackage.hasApex && testClasses.length === 0) {
      throw new BuildError(this.sfpmPackage.packageName, 'Package contains Apex but has no test classes defined', {
        buildStep: 'validation',
      });
    }

    this.logger?.info(`Validating '${this.sfpmPackage.packageName}' against ${targetOrg.getUsername()} [deploy+test]`);
    this.logger?.info(`Running ${testClasses.length} test class(es): ${testClasses.join(', ')}`);

    this.sink?.taskValidateStart({
      testCount: testClasses.length,
      testLevel: VALIDATION_TEST_LEVEL,
    });

    const deployService = new MetadataDeployService(this.logger);

    // Deploy metadata with specified tests — use the artifact's metadata path
    const metadataPath = path.join(this.workingDirectory, 'force-app');
    const componentSet = this.sfpmPackage.getComponentSet(metadataPath);
    const deployId = await deployService.deploy(componentSet, targetOrg.getConnection(), {
      testClasses,
      testLevel: VALIDATION_TEST_LEVEL,
    });

    // Return pending descriptor — the orchestrator decides whether to await resolution
    return {
      operationId: deployId,
      operationType: 'deploy',
      packageName: this.sfpmPackage.packageName,
      startedAt: new Date().toISOString(),
      targetOrg: targetOrg.getUsername() as string,
    };
  }
}
