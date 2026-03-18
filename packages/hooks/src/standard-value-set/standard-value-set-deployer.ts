import type {Logger} from '@b64/sfpm-core';
import type {Connection} from '@salesforce/core';

import {ComponentSet} from '@salesforce/source-deploy-retrieve';

import type {StandardValueSetDeployResult} from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Poll frequency in milliseconds. */
const POLL_FREQUENCY_MS = 10_000;
/** Maximum time to wait for the deploy in milliseconds. */
const POLL_TIMEOUT_MS = 600_000;

// ============================================================================
// StandardValueSetDeployer
// ============================================================================

/**
 * Deploys standard value set metadata to a Salesforce org using the
 * Metadata API.
 *
 * Creates a {@link ComponentSet} from the source path containing the
 * SVS files and performs a non-test deploy. Progress is logged
 * throughout the deploy lifecycle.
 */
export class StandardValueSetDeployer {
  constructor(
    private readonly connection: Connection,
    private readonly logger?: Logger,
  ) {}

  /**
   * Deploy standard value sets from the given source path.
   *
   * @param sourcePath - Absolute path to the directory containing
   *   `*.standardValueSet-meta.xml` files (typically
   *   `<packageDir>/standardValueSets`).
   * @param valueSetNames - Optional filter. When provided, only value
   *   sets whose API names are in this list are deployed.
   * @returns A simplified deploy result.
   */
  async deploy(
    sourcePath: string,
    valueSetNames?: string[],
  ): Promise<StandardValueSetDeployResult> {
    let componentSet = ComponentSet.fromSource(sourcePath);

    // Filter to requested value set names if specified
    if (valueSetNames?.length) {
      const nameSet = new Set(valueSetNames);
      const filtered = new ComponentSet();
      for (const component of componentSet) {
        if (nameSet.has(component.fullName)) {
          filtered.add(component);
        }
      }

      componentSet = filtered;
    }

    if (componentSet.size === 0) {
      this.logger?.debug('StandardValueSet: component set is empty after filtering, nothing to deploy');
      return {componentsDeployed: 0, componentsTotal: 0, success: true};
    }

    this.logger?.info(`StandardValueSet: deploying ${componentSet.size} standard value set(s)`);

    const deploy = await componentSet.deploy({
      apiOptions: {
        ignoreWarnings: true,
        rest: true,
        rollbackOnError: true,
        testLevel: 'NoTestRun',
      },
      usernameOrConnection: this.connection,
    });

    this.logger?.debug(`StandardValueSet: deploy started with id ${deploy.id}`);

    // Log progress on each poll
    deploy.onUpdate(response => {
      this.logger?.debug(`StandardValueSet: ${response.status} — `
        + `${response.numberComponentsDeployed}/${response.numberComponentsTotal} components`);
    });

    const result = await deploy.pollStatus(POLL_FREQUENCY_MS, POLL_TIMEOUT_MS);

    const {response} = result;

    if (response.success) {
      this.logger?.info(`StandardValueSet: successfully deployed ${response.numberComponentsDeployed} component(s)`);
    } else {
      this.logger?.warn('StandardValueSet: deployment failed');

      if (response.details && 'componentFailures' in response.details) {
        this.logger?.warn(`StandardValueSet: component failures: ${JSON.stringify(response.details.componentFailures)}`);
      }
    }

    return {
      componentsDeployed: response.numberComponentsDeployed,
      componentsTotal: response.numberComponentsTotal,
      success: response.success,
    };
  }
}
