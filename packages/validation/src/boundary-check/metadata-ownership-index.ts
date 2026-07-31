import {basename, extname} from 'node:path';

export interface PackageManifest {
  declaredDependencies: Set<string>;  // packageIds
  ownedFiles: Set<string>;            // absolute paths
  packageId: string;
}

export interface MetadataOwnership {
  filePath: string;
  metadataName: string;
  metadataType: 'apexclass' | 'apextrigger' | 'customfield' | 'customobject' | string;
  packageId: string;
}

/** Maps file extension → metadata type. Add an entry here to support a new type. */
const EXTENSION_TO_TYPE = new Map<string, MetadataOwnership['metadataType']>([
  ['.cls', 'apexclass'],
  ['.field-meta.xml', 'customfield'],
  ['.object-meta.xml', 'customobject'],
  ['.trigger', 'apextrigger'],
]);

export function buildOwnershipIndex(manifests: PackageManifest[]): Map<string, MetadataOwnership> {
  const index = new Map<string, MetadataOwnership>();
  for (const manifest of manifests) {
    for (const filePath of manifest.ownedFiles) {
      const ext = extname(filePath);
      const metadataType = EXTENSION_TO_TYPE.get(ext);
      if (!metadataType) continue;

      const metadataName = basename(filePath, ext).toLowerCase();
      index.set(metadataName, {
        filePath,
        metadataName,
        metadataType,
        packageId: manifest.packageId,
      });
    }
  }

  return index;
}
