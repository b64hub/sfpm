import { EventEmitter } from "node:events";
import ProjectService from "./project/project-service.js";
import { CoreEvents } from "./types/events.js";

import { SfdxProjectReader } from "./project/sfdx-project-reader.js";

export class SfpmCore extends EventEmitter<CoreEvents> {
  project: ProjectService;

  constructor(options: { apiKey: string; verbose?: boolean; projectPath?: string }) {
    super();
    this.project = new ProjectService({
      fileReader: options.projectPath ? new SfdxProjectReader(options.projectPath) : undefined
    });
  }
}
export * from './project/version-manager.js';
export * from './project/project-service.js';
export * from './project/sfdx-project-reader.js';
export * from './types/events.js';
export * from './project/types.js';
