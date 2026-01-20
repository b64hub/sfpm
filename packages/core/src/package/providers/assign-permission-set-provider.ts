import SfpmPackage from "../sfpm-package.js";
import { MetadataProvider } from "../package-builder.js";
import { SfpmPackageMetadata } from "../../types/package.js";

/**
 * @description Provides the pre/post deployment permission set assignments for the package.
 */
export class AssignPermissionSetProvider implements MetadataProvider {
    public async provide(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageMetadata>> {
        const packageDef = sfpmPackage.packageDefinition;
        return {
            orchestration: {
                assignPermSetsPreDeployment: packageDef?.assignPermSetsPreDeployment || [],
                assignPermSetsPostDeployment: packageDef?.assignPermSetsPostDeployment || []
            }
        };
    }
}
