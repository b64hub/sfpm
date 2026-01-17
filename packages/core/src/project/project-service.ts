import { VersionManager, VersionManagerConfig } from './version-manager.js';
import ProjectConfig from './project-config.js';
import { ProjectGraph } from './project-graph.js';
import { SfdxProjectReader } from './sfdx-project-reader.js';

export default class ProjectService {
    private versionManager: VersionManager;
    private projectConfig: ProjectConfig;

    constructor(config: VersionManagerConfig = {}) {

        const fileReader = new SfdxProjectReader();
        if (!config.fileReader) {
            config.fileReader = fileReader;
        }
        this.versionManager = new VersionManager(config);
        this.projectConfig = new ProjectConfig(fileReader);
    }

    public getVersionManager(): VersionManager {
        return this.versionManager;
    }

    public getProjectGraph(): ProjectGraph | undefined {
        return this.versionManager.getGraph();
    }

    public getProjectConfig(): ProjectConfig | undefined {
        return this.projectConfig;
    }
}