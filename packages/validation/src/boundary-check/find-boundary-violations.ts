import type {CaveatCode, DependencyGraphProvider} from '../types/dependency-graph.js';
import type {ValidationContext} from '../types/validation-context.js';
import type {MetadataOwnership, PackageManifest} from './metadata-ownership-index.js';

import {directDependencies} from '../types/dependency-graph.js';

export interface BoundaryViolation {
  fromMetadata: string;
  fromPackage: string;
  toMetadata: string;
  toPackage: string;
}

export interface BoundaryCheckResult {
  caveats: CaveatCode[];
  unresolved: string[];
  violations: BoundaryViolation[];
}

export async function findPackageBoundaryViolations(
  pkg: PackageManifest,
  ownershipIndex: Map<string, MetadataOwnership>,
  graphProvider: DependencyGraphProvider,
  context: Pick<ValidationContext, 'packageId' | 'projectRoot'>,
  concurrency = 5,
): Promise<BoundaryCheckResult> {
  const ownedMetadata = [...ownershipIndex.values()].filter(o => o.packageId === pkg.packageId);
  const violations: BoundaryViolation[] = [];
  const caveatCodes = new Set<CaveatCode>();
  const unresolved = new Set<string>();

  const queue = [...ownedMetadata];
  await Promise.all(Array.from({length: concurrency}, async () => {
    while (queue.length > 0) {
      const owned = queue.shift();
      if (!owned) break;
      // eslint-disable-next-line no-await-in-loop
      const node = await graphProvider.getMetadataDependencies(
        {name: owned.fileName, type: owned.metadataType},
        context,
      );

      for (const caveat of node.caveats) caveatCodes.add(caveat.code);

      for (const edge of directDependencies(node)) {
        const depKey = edge.target.name.toLowerCase();
        const dep = ownershipIndex.get(depKey);
        if (!dep) {
          unresolved.add(depKey);
          continue;
        }

        if (dep.packageId === pkg.packageId) continue;
        if (!pkg.declaredDependencies.has(dep.packageId)) {
          violations.push({
            fromMetadata: node.metadataName,
            fromPackage: pkg.packageId,
            toMetadata: dep.fileName,
            toPackage: dep.packageId,
          });
        }
      }
    }
  }));

  return {caveats: [...caveatCodes], unresolved: [...unresolved], violations};
}
