import { Builder, RegisterBuilder } from "./builder-registry.js";
import { PackageType } from "../../types/package.js";
import { Logger } from "../../types/logger.js";

@RegisterBuilder(PackageType.Source)
class SourcePackageBuilder implements Builder {

    constructor(
        workingDirectory: string,
        sfpmPackage: any,
        logger?: Logger,
    ) { }

    exec(): Promise<any> {
        return Promise.resolve();
    }
}
