import SfpmPackage from "../../sfpm-package.js";

/**
 * Interface for installation-related auxiliary tasks
 * 
 * These are tasks that happen before or after the core installation operation,
 * such as:
 * - Activating flows
 * - Running pre-install scripts
 * - Running post-install scripts
 * - Assigning permission sets
 * - Data seeding
 * - Org configuration
 * 
 * The core installation itself (source deploy or version install) is NOT a task,
 * but rather a core operation of the installation strategy.
 */
export interface InstallTask {
    /**
     * Execute the auxiliary task
     */
    exec(): Promise<void>;
}
