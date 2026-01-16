import { EventEmitter } from "node:events";
import ProjectService from "./project/project-service.js";
import { CoreEvents } from "./types/events.js";

export class SfpmCore extends EventEmitter<CoreEvents> {
  project: ProjectService;

  constructor(options: { apiKey: string; verbose?: boolean }) {
    super();
    this.project = new ProjectService({});
  }
}
export * from './project/version-manager.js';
export * from './project/project-service.js';
export * from './types/events.js';
export * from './project/types.js';
