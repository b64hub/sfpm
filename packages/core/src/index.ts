import { EventEmitter } from "node:events";
import ProjectService from "./project/project-service.js";
import { AllBuildEvents } from "./types/events.js";

// Import builders to trigger decorator registration
import './package/builders/unlocked-package-builder.js';
import './package/builders/source-package-builder.js';

// Import analyzers to trigger decorator registration
import './package/analyzers/apex-type-analyzer.js';
import './package/analyzers/fht-analyzer.js';
import './package/analyzers/ft-analyzer.js';
import './package/analyzers/manifest-analyzer.js';
import './package/analyzers/picklist-analyzer.js';

export class SfpmCore extends EventEmitter<AllBuildEvents> {
  project!: ProjectService;

  private constructor() {
    super();
  }

  /**
   * Creates and initializes a new SfpmCore instance.
   * This is the recommended way to create an SfpmCore instance.
   */
  static async create(options: { apiKey: string; verbose?: boolean; projectPath?: string }): Promise<SfpmCore> {
    const core = new SfpmCore();
    core.project = await ProjectService.create(options.projectPath);
    return core;
  }
}
export * from './project/version-manager.js';
export { default as ProjectService } from './project/project-service.js';
export { default as ProjectConfig } from './project/project-config.js';
export { default as SfpmPackage, PackageFactory } from './package/sfpm-package.js';
export * from './types/events.js';
export * from './types/errors.js';
export * from './types/project.js';
export * from './project/project-graph.js';
export * from './types/package.js';
export { PackageBuilder } from './package/package-builder.js'; // Avoid export * due to BuildOptions name conflict with types/project.ts
export * from './types/logger.js';
export { GitService } from './git/git-service.js';
export { default as Git } from './git/git.js';
