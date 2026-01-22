import { ComponentSet } from "@salesforce/source-deploy-retrieve";
import { PackageAnalyzer, RegisterAnalyzer } from "./analyzer-registry.js";
import { PackageType, SfpmPackageMetadata } from "../../types/package.js";
import SfpmPackage from "../sfpm-package.js";

import { Logger } from "../../types/logger.js";

@RegisterAnalyzer()
export default class FHTAnalyzer implements PackageAnalyzer {
    private logger?: Logger;

    constructor(logger?: Logger) {
        this.logger = logger;
    }

    public isEnabled(sfpmPackage: SfpmPackage): boolean {
        return (sfpmPackage.type !== PackageType.Data);
    }

    public async analyze(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageMetadata>> {
        


        return sfpmPackage;
    }
}