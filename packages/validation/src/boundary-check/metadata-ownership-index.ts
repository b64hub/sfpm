import {ComponentSet} from '@salesforce/source-deploy-retrieve';

import type {MetadataType} from '../types/dependency-graph.js';

export interface PackageManifest {
  declaredDependencies: Set<string>;  // packageIds
  packageId: string;
  packagePath: string;            // absolute path
}

export interface MetadataOwnership {
  fileName: string;
  filePath: string;
  metadataName: string;
  metadataType: MetadataType;
  packageId: string;
}

const SDR_TO_METADATA_TYPE: Partial<Record<string, MetadataType>> = {
  apexclass: 'ApexClass',
  apextrigger: 'ApexTrigger',
  customlabel: 'CustomLabel',
  custommetadata: 'CustomMetadataType',
  customobject: 'SObject',
  flow: 'Flow',
};

export function buildOwnershipIndex(manifests: PackageManifest[]): Map<string, MetadataOwnership> {
  const index = new Map<string, MetadataOwnership>();
  for (const manifest of manifests) {
    const cs = ComponentSet.fromSource(manifest.packagePath);

    for (const component of cs.getSourceComponents()) {
      const metadataType = SDR_TO_METADATA_TYPE[component.type.id];
      if (!metadataType) continue;
      const metadataName = component.fullName.toLowerCase();
      index.set(metadataName, {
        fileName: component.fullName,
        filePath: component.xml ?? component.walkContent()[0] ?? '',
        metadataName,
        metadataType,
        packageId: manifest.packageId,
      });
    }
  }

  return index;
}
