import { PackageAnalyzer, RegisterAnalyzer } from "./analyzer-registry.js";
import SfpmPackage from "../sfpm-package.js";
import { Logger } from "../../types/logger.js";

@RegisterAnalyzer()
export class ApexTestAnalyzer implements PackageAnalyzer {
    constructor(private logger?: Logger) { }

    public async analyze(
        sfpmPackage: SfpmPackage,
        componentSet: any
    ): Promise<SfpmPackage> {
        // Logic to analyze apex tests
        // For example, finding test classes in the componentSet
        // and updating sfpmPackage.metadata.content.apex.testClasses

        if (this.logger) {
            this.logger.info("Running ApexTestAnalyzer...");
        }

        // Placeholder logic: just mark it as analyzed
        sfpmPackage.metadata.validation = sfpmPackage.metadata.validation || {};

        return sfpmPackage;
    }

    public isEnabled(sfpmPackage: SfpmPackage): boolean {
        return sfpmPackage.hasApex;
    }
}
