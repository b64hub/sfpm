import EventEmitter from 'node:events';
import fs from 'fs-extra';
import path from 'path';

import {
  type Builder,
  type BuildTask,
  type Logger,
  PackageType,
  RegisterBuilder,
  SfpmDataPackage,
  type SfpmPackage,
} from '@b64/sfpm-core';

import type {SfdmuExportJson} from './types.js';

/**
 * Builder for SFDMU-based data packages.
 *
 * This is where SFDMU-specific knowledge lives. The builder knows what
 * valid data package contents look like (export.json + CSV files) and
 * validates their presence during the build.
 *
 * Core's PackageBuilder handles staging (via PackageAssembler) and artifact
 * assembly. This builder runs between those phases to perform SFDMU-specific
 * validation and preparation.
 */
// eslint-disable-next-line new-cap
@RegisterBuilder(PackageType.Data)
export default class SfdmuDataBuilder extends EventEmitter implements Builder {
  public postBuildTasks: BuildTask[] = [];
  public preBuildTasks: BuildTask[] = [];
  private readonly logger?: Logger;
  private readonly sfpmPackage: SfpmDataPackage;
  private readonly workingDirectory: string;

  constructor(
    workingDirectory: string,
    sfpmPackage: SfpmPackage,
    logger?: Logger,
  ) {
    super();
    if (!(sfpmPackage instanceof SfpmDataPackage)) {
      throw new TypeError(`SfdmuDataBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.workingDirectory = workingDirectory;
    this.sfpmPackage = sfpmPackage;
    this.logger = logger;
  }

  /**
   * Data packages do not require a DevHub connection.
   */
  public async connect(_username: string): Promise<void> {
    // No-op: data packages don't need DevHub
  }

  /**
   * Execute the build pipeline: pre-build tasks -> validate -> post-build tasks.
   */
  public async exec(): Promise<void> {
    await this.runPreBuildTasks();
    await this.validate();
    await this.runPostBuildTasks();
  }

  /**
   * SFDMU-specific validation:
   * 1. Verify export.json exists in the data directory
   * 2. Parse and validate its basic structure
   * 3. Count data files for metadata
   */
  private async validate(): Promise<void> {
    this.emit('task:start', {
      packageName: this.sfpmPackage.packageName,
      taskName: 'SfdmuValidation',
      taskType: 'build',
      timestamp: new Date(),
    });

    const exportJsonPath = path.join(this.workingDirectory, 'export.json');

    // Validate export.json exists
    // eslint-disable-next-line no-await-in-loop
    if (!await fs.pathExists(exportJsonPath)) {
      const error = new Error(
        `export.json not found at ${exportJsonPath}. ` +
        'SFDMU data packages must contain an export.json file in the package directory.',
      );

      this.emit('task:complete', {
        packageName: this.sfpmPackage.packageName,
        success: false,
        taskName: 'SfdmuValidation',
        taskType: 'build',
        timestamp: new Date(),
      });

      throw error;
    }

    // Parse and validate basic structure
    try {
      const exportJson: SfdmuExportJson = await fs.readJson(exportJsonPath);

      if (!exportJson.objects || !Array.isArray(exportJson.objects)) {
        throw new Error('export.json must contain an "objects" array');
      }

      if (exportJson.objects.length === 0) {
        throw new Error('export.json "objects" array must not be empty');
      }

      const sObjectNames = exportJson.objects.map(o => o.objectName);
      this.logger?.info(`SFDMU export.json validated: ${sObjectNames.length} sObject(s) configured: ${sObjectNames.join(', ')}`);

      // Log CSV files found
      // eslint-disable-next-line no-await-in-loop
      const csvFiles = await this.findCsvFiles();
      if (csvFiles.length > 0) {
        this.logger?.info(`Found ${csvFiles.length} CSV file(s): ${csvFiles.join(', ')}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`export.json contains invalid JSON: ${error.message}`);
      }

      throw error;
    }

    this.emit('task:complete', {
      packageName: this.sfpmPackage.packageName,
      success: true,
      taskName: 'SfdmuValidation',
      taskType: 'build',
      timestamp: new Date(),
    });
  }

  private async findCsvFiles(): Promise<string[]> {
    const files = await fs.readdir(this.workingDirectory);
    return files.filter(f => f.toLowerCase().endsWith('.csv'));
  }

  private async runPostBuildTasks(): Promise<void> {
    for (const task of this.postBuildTasks) {
      const taskName = task.constructor.name;

      this.emit('task:start', {
        packageName: this.sfpmPackage.packageName,
        taskName,
        taskType: 'post-build',
        timestamp: new Date(),
      });

      try {
        await task.exec();

        this.emit('task:complete', {
          packageName: this.sfpmPackage.packageName,
          success: true,
          taskName,
          taskType: 'post-build',
          timestamp: new Date(),
        });
      } catch (error) {
        this.emit('task:complete', {
          packageName: this.sfpmPackage.packageName,
          success: false,
          taskName,
          taskType: 'post-build',
          timestamp: new Date(),
        });

        throw error;
      }
    }
  }

  private async runPreBuildTasks(): Promise<void> {
    for (const task of this.preBuildTasks) {
      const taskName = task.constructor.name;

      this.emit('task:start', {
        packageName: this.sfpmPackage.packageName,
        taskName,
        taskType: 'pre-build',
        timestamp: new Date(),
      });

      try {
        await task.exec();

        this.emit('task:complete', {
          packageName: this.sfpmPackage.packageName,
          success: true,
          taskName,
          taskType: 'pre-build',
          timestamp: new Date(),
        });
      } catch (error) {
        this.emit('task:complete', {
          packageName: this.sfpmPackage.packageName,
          success: false,
          taskName,
          taskType: 'pre-build',
          timestamp: new Date(),
        });

        throw error;
      }
    }
  }
}
