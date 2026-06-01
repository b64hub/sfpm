import path from 'node:path';

import {ApexClassifier} from '../../apex/apex-classifier.js';
import {PackageType, SfpmPackageContent} from '../../types/package.js';
import {SfpmMetadataPackage} from '../sfpm-package.js';
import {PackageAnalyzer, RegisterAnalyzer} from './analyzer-registry.js';

/**
 * To be implemented using Apex Language Server
 */
// eslint-disable-next-line new-cap -- We want to use the decorator pattern for analyzers
@RegisterAnalyzer()
export class ApexTypeAnalyzer implements PackageAnalyzer {
  public async analyze(sfpmPackage: SfpmMetadataPackage): Promise<Partial<SfpmPackageContent>> {
    const components = sfpmPackage.apexClasses
    .filter(ac => ac.content !== undefined);

    const filePaths = components.map(ac => ac.content as string);

    const classifier = new ApexClassifier();
    const classification = await classifier.classifyBulk(filePaths);

    // Use SourceComponent.name for reliable names (parser returns "Unknown" on heuristic fallback)
    // Use relative path from staging directory for portable artifact paths
    const baseDir = sfpmPackage.workingDirectory || sfpmPackage.projectDirectory;

    const enriched = classification.map((info, index) => ({
      ...info,
      name: components[index].name || info.name,
      path: path.relative(baseDir, components[index].content!),
    }));

    const classes = enriched
    .filter(info => !info.isTest)
    .map(info => ({
      name: info.name,
      path: info.path,
    }));

    const testClasses = enriched
    .filter(info => info.isTest)
    .map(info => ({
      name: info.name,
      path: info.path,
    }));

    return {
      content: {
        apex: {
          classes,
          tests: testClasses,
        },
      },
    };
  }

  public isEnabled(sfpmPackage: SfpmMetadataPackage): boolean {
    return sfpmPackage.type !== PackageType.Source && sfpmPackage.hasApex;
  }
}
