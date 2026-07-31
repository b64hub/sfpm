import {ComponentSet} from '@salesforce/source-deploy-retrieve';

export interface PackageManifest {
  declaredDependencies: Set<string>;  // packageIds
  packageId: string;
  packagePath: string;            // absolute path
}

export interface MetadataOwnership {
  fileName: string;
  filePath: string;
  metadataName: string;
  metadataType: string;
  packageId: string;
}

export function buildOwnershipIndex(manifests: PackageManifest[]): Map<string, MetadataOwnership> {
  const index = new Map<string, MetadataOwnership>();
  for (const manifest of manifests) {
    const cs = ComponentSet.fromSource([...manifest.ownedFiles]);
    for (const component of cs.getSourceComponents()) {
      const metadataName = component.fullName.toLowerCase();
      index.set(metadataName, {
        fileName: component.fullName,
        filePath: component.xml ?? component.walkContent()[0] ?? '',
        metadataName,
        metadataType: component.type.id,
        packageId: manifest.packageId,
      });
    }
  }

  return index;
}
