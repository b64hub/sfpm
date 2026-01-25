import { EventEmitter } from "node:events";
import ProjectService from "./project/project-service.js";
import { CoreEvents } from "./types/events.js";

export class SfpmCore extends EventEmitter<CoreEvents> {
  project: ProjectService;

  constructor(options: { apiKey: string; verbose?: boolean; projectPath?: string }) {
    super();
    this.project = new ProjectService(options.projectPath);
  }
}
export * from './project/version-manager.js';
export { default as ProjectService } from './project/project-service.js';
export { default as ProjectConfig } from './project/project-config.js';
export { default as SfpmPackage } from './package/sfpm-package.js';
export * from './types/events.js';
export * from './types/project.js';
export * from './project/project-graph.js';
export * from './types/package.js';
export { PackageBuilder } from './package/package-builder.js'; // Avoid export * due to BuildOptions name conflict with types/project.ts
export * from './types/logger.js';
