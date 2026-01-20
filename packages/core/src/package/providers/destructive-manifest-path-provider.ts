import SfpmPackage from "../sfpm-package.js";
import { MetadataProvider } from "../package-builder.js";
import { SfpmPackageMetadata } from "../../types/package.js";

/**
 * @description Provides the destructive manifest path for the package.
 */
export class DestructiveManifestPathProvider implements MetadataProvider {
    public async provide(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageMetadata>> {
        const packageDef = sfpmPackage.packageDefinition;
        return {
            content: {
                destructiveChangesPath: packageDef?.destructiveChangesPath
            }
        };
    }
}
