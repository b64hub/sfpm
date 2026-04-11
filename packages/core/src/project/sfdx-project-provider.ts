/**
 * Legacy sfdx-project.json–based ProjectDefinitionProvider.
 *
 * Reads the project definition directly from sfdx-project.json via
 * @salesforce/core's SfProject. This is the traditional approach used
 * when no workspace configuration is detected.
 */

import {SfProject} from '@salesforce/core';

import type {ProjectDefinition} from '../types/project.js';
import type {ProjectDefinitionProvider, ProjectDefinitionResult} from './project-definition-provider.js';

export class SfdxProjectDefinitionProvider implements ProjectDefinitionProvider {
  public readonly projectDir: string;

  constructor(private readonly sfProject: SfProject) {
    this.projectDir = sfProject.getPath();
  }

  resolve(): ProjectDefinitionResult {
    const definition = this.sfProject.getSfProjectJson().getContents() as unknown as ProjectDefinition;
    return {definition};
  }
}
