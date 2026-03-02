import EventEmitter from 'node:events';

import {SourceBuildEvents} from '../../types/events.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import {BuildTask} from '../package-builder.js';
import SfpmPackage, {SfpmSourcePackage} from '../sfpm-package.js';
import {Builder, RegisterBuilder} from './builder-registry.js';
import SourceHashTask from './tasks/source-hash-task.js';

export interface SourcePackageBuilderOptions {
}

@RegisterBuilder(PackageType.Source)
export default class SourcePackageBuilder extends EventEmitter<SourceBuildEvents> implements Builder {
  public postBuildTasks: BuildTask[] = [];
  public preBuildTasks: BuildTask[] = [];
  private logger?: Logger;
  private sfpmPackage: SfpmSourcePackage;
  private workingDirectory: string;

  constructor(
    workingDirectory: string,
    sfpmPackage: SfpmPackage,
    logger?: Logger,
  ) {
    super();
    if (!(sfpmPackage instanceof SfpmSourcePackage)) {
      throw new TypeError(`SourcePackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.workingDirectory = workingDirectory;
    this.sfpmPackage = sfpmPackage;
    this.logger = logger;

    // Add source hash check to prevent redundant builds
    const projectDir = this.sfpmPackage.projectDirectory;
    this.preBuildTasks.push(new SourceHashTask(this.sfpmPackage, projectDir, this.logger));
  }

  public async buildPackage(): Promise<void> {
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

  public async connect(username: string): Promise<void> {

  }

  public async exec(): Promise<void> {
    await this.runPreBuildTasks();
    await this.buildPackage();
    await this.runPostBuildTasks();
  }

  public async runPostBuildTasks() {
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

  public async runPreBuildTasks() {
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
        const success = error instanceof Error && (error as any).code === 'BUILD_NOT_REQUIRED';

        this.emit('task:complete', {
          packageName: this.sfpmPackage.packageName,
          success,
          taskName,
          taskType: 'pre-build',
          timestamp: new Date(),
        });

        throw error;
      }
    }
  }

  private handleApexTestClasses(sfpmPackage: SfpmSourcePackage) {
    if (sfpmPackage.hasApex && sfpmPackage.testClasses.length === 0) {
      sfpmPackage.isTriggerAllTests = true;
    }
  }
}
