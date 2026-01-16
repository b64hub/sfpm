import { ProjectDefinition } from './types.js';

export interface ProjectFileReader {
    read(): Promise<ProjectDefinition>;
    write(project: ProjectDefinition): Promise<void>;
}
