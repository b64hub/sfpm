import { VersionManager, VersionManagerConfig } from './version-manager.js';
import { ProjectGraph } from './project-graph.js';
import { ProjectFileReader } from './project-file-reader.js';
import { SfdxProjectReader } from './sfdx-project-reader.js';

export default class ProjectService {
    private versionManager: VersionManager;

    constructor(config: VersionManagerConfig = {}) {
        if (!config.fileReader) {
            config.fileReader = new SfdxProjectReader();
        }
        this.versionManager = new VersionManager(config);
    }

    public getVersionManager(): VersionManager {
        return this.versionManager;
    }

    public getProjectGraph(): ProjectGraph | undefined {
        return this.versionManager.getGraph();
    }
}