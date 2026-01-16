import { ProjectDefinition, ProjectFileReader } from './types.js';
import fs from 'fs-extra';

export class SfdxProjectReader implements ProjectFileReader {
    constructor(private readonly projectPath: string = 'sfdx-project.json') { }

    async read(): Promise<ProjectDefinition> {
        if (!await fs.pathExists(this.projectPath)) {
            throw new Error(`Project file not found at ${this.projectPath}`);
        }
        return fs.readJSON(this.projectPath) as Promise<ProjectDefinition>;
    }

    async write(project: ProjectDefinition): Promise<void> {
        await fs.writeJSON(this.projectPath, project, { spaces: 4 });
    }
}
