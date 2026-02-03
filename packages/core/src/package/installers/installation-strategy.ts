import SfpmPackage from "../sfpm-package.js";
import { InstallationSource, InstallationMode } from "../../types/package.js";
import { Logger } from "../../types/logger.js";

/**
 * Interface for installation strategy implementations
 * Strategies handle different installation modes (source deploy vs. version install)
 */
export interface InstallationStrategy {
    /**
     * Determines if this strategy can handle the given package and source
     * @param source - Where the code comes from (local project or artifact)
     * @param sfpmPackage - The package to install
     */
    canHandle(source: InstallationSource, sfpmPackage: SfpmPackage): boolean;
    
    /**
     * Gets the installation mode this strategy will use.
     * Note: Source packages always use SourceDeploy; this is mainly for unlocked packages.
     */
    getMode(): InstallationMode;
    
    /**
     * Executes the installation using this strategy
     */
    install(sfpmPackage: SfpmPackage, targetOrg: string): Promise<void>;
}
