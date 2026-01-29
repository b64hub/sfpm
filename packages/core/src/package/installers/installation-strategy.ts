import SfpmPackage from "../sfpm-package.js";
import { InstallationSourceType, InstallationMode } from "../../types/package.js";
import { Logger } from "../../types/logger.js";

/**
 * Interface for installation strategy implementations
 * Strategies handle different installation modes (source deploy vs. version install)
 */
export interface InstallationStrategy {
    /**
     * Determines if this strategy can handle the given package and source type
     */
    canHandle(sourceType: InstallationSourceType, sfpmPackage: SfpmPackage): boolean;
    
    /**
     * Gets the installation mode this strategy will use
     */
    getMode(): InstallationMode;
    
    /**
     * Executes the installation using this strategy
     */
    install(sfpmPackage: SfpmPackage, targetOrg: string): Promise<void>;
}
