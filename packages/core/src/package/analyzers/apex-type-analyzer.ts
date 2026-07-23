import {ApexClassifier} from '../../apex/apex-classifier.js';
import {PackageType, SfpmPackageContent} from '../../types/package.js';
import {SfpmMetadataPackage} from '../sfpm-package.js';
import {PackageAnalyzer, RegisterAnalyzer} from './analyzer-registry.js';

// eslint-disable-next-line new-cap -- We want to use the decorator pattern for analyzers
@RegisterAnalyzer()
export class ApexTypeAnalyzer implements PackageAnalyzer {
  public readonly name = 'ApexTypeAnalyzer';

  public async analyze(sfpmPackage: SfpmMetadataPackage): Promise<Partial<SfpmPackageContent>> {
    const components = sfpmPackage.apexClasses.filter(ac => ac.content !== undefined);
    const classification = await new ApexClassifier().classifyBulk(components.map(ac => ac.content as string));

    const classes: string[] = [];
    const tests: string[] = [];
    for (const [i, info] of classification.entries()) {
      // SourceComponent.name is more reliable than the classifier heuristic
      const name = components[i].name || info.name;
      (info.isTest ? tests : classes).push(name);
    }

    sfpmPackage.updateContent({apex: {classes, tests}});
    return {};
  }

  public isEnabled(sfpmPackage: SfpmMetadataPackage): boolean {
    return sfpmPackage.type !== PackageType.Source && sfpmPackage.hasApex;
  }
}
