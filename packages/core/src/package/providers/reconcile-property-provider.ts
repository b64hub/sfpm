import SfpmPackage from "../sfpm-package.js";
import { MetadataProvider } from "../package-builder.js";
import { SfpmPackageMetadata } from "../../types/package.js";

/**
 * @description Provides the profile reconciliation flag for the package.
 */
export class ReconcilePropertyProvider implements MetadataProvider {
    public async provide(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageMetadata>> {
        const packageDef = sfpmPackage.packageDefinition;
        return {
            orchestration: {
                reconcileProfiles: packageDef?.reconcileProfiles || false
            }
        };
    }
}
