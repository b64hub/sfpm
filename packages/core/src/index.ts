import { EventEmitter } from "node:events";
import ProjectService from "./project/project-service.js";
import { CoreEvents } from "./types/events.js";

export class SfpCore extends EventEmitter<CoreEvents> {
  project: ProjectService;

  constructor(options: { apiKey: string; verbose?: boolean }) {
    super();
    this.project = new ProjectService();
  }
}
