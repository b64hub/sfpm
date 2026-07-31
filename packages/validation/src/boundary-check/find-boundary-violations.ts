import type {DependencyGraphProvider} from '../ports/dependency-graph.js';
import type {ValidationContext} from '../ports/validation-context.js';
import type {MetadataOwnership, PackageManifest} from './metadata-ownership-index.js';

export interface BoundaryViolation {
  fromClass: string;
  fromPackage: string;
  toClass: string;
  toPackage: string;
}

export interface BoundaryCheckResult {
  caveats: string[];
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
  const caveats = new Set<string>();
  const unresolved = new Set<string>();

  const queue = [...ownedMetadata];
  await Promise.all(Array.from({length: concurrency}, async () => {
    while (queue.length > 0) {
      const owned = queue.shift();
      if (!owned) break;
      // eslint-disable-next-line no-await-in-loop
      const graph = await graphProvider.getMetadataDependencies(owned.metadataName, owned.metadataType, context);
      for (const limit of graph.limits) caveats.add(limit);

      // Only Apex classes carry a static `dependencies` list — SObject and
      // Flow graphs express cross-boundary access differently. Skip non-class
      // types here until boundary checking is extended to cover them.
      if (!('dependencies' in graph)) continue;

      for (const depLower of graph.dependencies) {
        const dep = ownershipIndex.get(depLower);
        if (!dep) {
          unresolved.add(depLower);
          continue;
        }

        if (dep.packageId === pkg.packageId) continue;
        if (!pkg.declaredDependencies.has(dep.packageId)) {
          violations.push({
            fromClass: owned.metadataName,
            fromPackage: pkg.packageId,
            toClass: depLower,
            toPackage: dep.packageId,
          });
        }
      }
    }
  }));

  return {caveats: [...caveats], unresolved: [...unresolved], violations};
}
