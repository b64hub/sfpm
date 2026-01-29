import EventEmitter from 'node:events';
import { Builder, RegisterBuilder } from "./builder-registry.js";
import { BuildTask } from "../package-builder.js";
import { PackageType } from "../../types/package.js";
import SfpmPackage, { SfpmSourcePackage } from "../sfpm-package.js";
import { Logger } from "../../types/logger.js";
import { SourceBuildEvents } from "../../types/events.js";
import SourceHashTask from './tasks/source-hash-task.js';

export interface SourcePackageBuilderOptions {
}

@RegisterBuilder(PackageType.Source)
export default class SourcePackageBuilder extends EventEmitter<SourceBuildEvents> implements Builder {
    private workingDirectory: string;
    private sfpmPackage: SfpmSourcePackage;
    private logger?: Logger;

    public preBuildTasks: BuildTask[] = [];
    public postBuildTasks: BuildTask[] = [];

    constructor(
        workingDirectory: string,
        sfpmPackage: SfpmPackage,
        logger?: Logger,
    ) {
        super();
        if (!(sfpmPackage instanceof SfpmSourcePackage)) {
            throw new Error(`SourcePackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
        }
        this.workingDirectory = workingDirectory;
        this.sfpmPackage = sfpmPackage;
        this.logger = logger;

        // Add source hash check to prevent redundant builds
        const projectDir = this.sfpmPackage.projectDirectory;
        this.preBuildTasks.push(new SourceHashTask(this.sfpmPackage, projectDir, this.logger));
    }

    public async exec(): Promise<void> {
        await this.runPreBuildTasks();
        await this.buildPackage();
        await this.runPostBuildTasks();
    }

    public async connect(username: string): Promise<void> {
        return Promise.resolve();
    }

    public async runPreBuildTasks() {
        for (const task of this.preBuildTasks) {
            const taskName = task.constructor.name;
            
            this.emit('task:start', {
                timestamp: new Date(),
                packageName: this.sfpmPackage.packageName,
                taskName,
                taskType: 'pre-build',
            });

            try {
                await task.exec();
                
                this.emit('task:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    taskName,
                    taskType: 'pre-build',
                    success: true,
                });
            } catch (error) {
                const success = error instanceof Error && (error as any).code === 'BUILD_NOT_REQUIRED';
                
                this.emit('task:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    taskName,
                    taskType: 'pre-build',
                    success,
                });
                
                throw error;
            }
        }
    }

    public async runPostBuildTasks() {
        for (const task of this.postBuildTasks) {
            const taskName = task.constructor.name;
            
            this.emit('task:start', {
                timestamp: new Date(),
                packageName: this.sfpmPackage.packageName,
                taskName,
                taskType: 'post-build',
            });

            try {
                await task.exec();
                
                this.emit('task:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    taskName,
                    taskType: 'post-build',
                    success: true,
                });
            } catch (error) {
                this.emit('task:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    taskName,
                    taskType: 'post-build',
                    success: false,
                });
                
                throw error;
            }
        }
    }

    public async buildPackage() {
        this.emit('source:assemble:start', {
            timestamp: new Date(),
            packageName: this.sfpmPackage.packageName,
            sourcePath: this.workingDirectory,
        });

        this.handleApexTestClasses(this.sfpmPackage);

        this.emit('source:assemble:complete', {
            timestamp: new Date(),
            packageName: this.sfpmPackage.packageName,
            sourcePath: this.workingDirectory,
            artifactPath: this.workingDirectory,
        });
    }


    private handleApexTestClasses(sfpmPackage: SfpmSourcePackage) {
        if (sfpmPackage.hasApex && sfpmPackage.testClasses.length == 0) {
            sfpmPackage.isTriggerAllTests = true;
        }
    }
}
