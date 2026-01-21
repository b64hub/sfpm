import { MetadataProvider } from "../package-builder.js";
import SfpmPackage from "../sfpm-package.js";
import { PackageType, SfpmPackageMetadata } from "../../types/package.js";
import { ApexParser } from "../../apex/apex-parser.js";
import { glob } from "fast-glob";

/**
 * To be implemented using Apex Language Server
 */
export class ApexTypeProvider implements MetadataProvider {
    public async provide(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageMetadata>> {

        const files = await glob(["**/*.cls", "**/*.trigger"], { cwd: sfpmPackage.workingDirectory });

        const parser = new ApexParser();
        const classification = await parser.getInfoFromFiles(files);

        sfpmPackage.metadata.content.apex.classes = classification.map((info) => {
            if (info.type === "Class" && !info.isTest) {
                return {
                    name: info.name,
                    path: info.path,
                };
            }
        }) || [];
        sfpmPackage.metadata.content.apex.triggers = classification.map((info) => {
            if (info.type === "Trigger") {
                return {
                    name: info.name,
                    path: info.path,
                };
            }
        }) || [];
        sfpmPackage.metadata.content.apex.testClasses = classification.map((info) => {
            if (info.type === "Class" && info.isTest) {
                return {
                    name: info.name,
                    path: info.path,
                };
            }
        }) || [];

        sfpmPackage.metadata.validation.isTriggerAllTests = this.isTriggerAllTests(sfpmPackage);

        return {};
    }

    private isTriggerAllTests(sfpmPackage: SfpmPackage): boolean {
        return (
            !this.isOptimizedDeployment(sfpmPackage) ||
            (sfpmPackage.type === PackageType.Source && sfpmPackage.hasApex && sfpmPackage.apexTestClasses.length === 0)
        )
    }

    private isOptimizedDeployment(sfpmPackage: SfpmPackage): boolean {
        return (sfpmPackage.type === PackageType.Source && sfpmPackage.packageDefinition?.isOptimizedDeployment) || false;
    }

}