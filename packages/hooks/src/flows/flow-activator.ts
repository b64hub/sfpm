import type {Logger} from '@b64/sfpm-core';
import type {Connection} from '@salesforce/core';

import {escapeSOQL} from '@b64/sfpm-core';

import type {
  FlowActivationHooksOptions,
  FlowDefinitionRecord,
  PackageFlowEntry,
} from './types.js';

// ============================================================================
// FlowActivator
// ============================================================================

/**
 * Activates or deactivates flows in a Salesforce org to match the
 * intended status declared in the package source.
 *
 * For each flow in the package:
 * - **Active** in source → activate the latest version in the org
 *   (unless it is already active and `skipAlreadyActive` is set).
 * - **Draft / Obsolete / InvalidDraft** in source → deactivate in the org.
 *
 * Activation is performed by setting `FlowDefinition.Metadata.activeVersionNumber`
 * to the latest version number via the Tooling API. Deactivation sets it to `0`.
 */
export class FlowActivator {
  private readonly skipAlreadyActive: boolean;

  constructor(
    private readonly connection: Connection,
    private readonly options?: FlowActivationHooksOptions,
    private readonly logger?: Logger,
  ) {
    this.skipAlreadyActive = options?.skipAlreadyActive ?? true;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Process all flows — activate or deactivate each one to match its
   * intended source status.
   *
   * @returns Summary counts of activated and deactivated flows.
   */
  async processFlows(entries: PackageFlowEntry[]): Promise<{activated: number; deactivated: number}> {
    const toActivate = entries.filter(e => e.sourceStatus === 'Active');
    const toDeactivate = entries.filter(e => e.sourceStatus !== 'Active');

    let activated = 0;
    let deactivated = 0;

    for (const entry of toActivate) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.activateFlow(entry.developerName);
      if (ok) activated++;
    }

    for (const entry of toDeactivate) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.deactivateFlow(entry.developerName);
      if (ok) deactivated++;
    }

    return {activated, deactivated};
  }

  // --------------------------------------------------------------------------
  // Activation
  // --------------------------------------------------------------------------

  /**
   * Activate the latest version of a flow in the org.
   *
   * Queries `FlowDefinition` to compare the active and latest version
   * numbers. If the latest version is newer (or nothing is active), the
   * flow is activated via a Tooling API update.
   */
  private async activateFlow(developerName: string): Promise<boolean> {
    const flowDef = await this.queryFlowDefinition(developerName);
    if (!flowDef) {
      this.logger?.trace(`FlowActivation: flow '${developerName}' not found in org, skipping`);
      return false;
    }

    const activeVersion = flowDef.ActiveVersion?.VersionNumber ?? null;
    const latestVersion = flowDef.LatestVersion?.VersionNumber ?? null;

    if (latestVersion === null) {
      this.logger?.trace(`FlowActivation: flow '${developerName}' has no latest version, skipping`);
      return false;
    }

    // Skip if already active and option says so
    if (
      this.skipAlreadyActive
      && activeVersion !== null
      && activeVersion >= latestVersion
    ) {
      this.logger?.debug(`FlowActivation: flow '${developerName}' latest version is already active, skipping`);
      return false;
    }

    await this.setActiveVersion(flowDef.Id, developerName, latestVersion);
    this.logger?.info(`FlowActivation: activated flow '${developerName}'`);
    return true;
  }

  // --------------------------------------------------------------------------
  // Deactivation
  // --------------------------------------------------------------------------

  /**
   * Deactivate a flow in the org by clearing its active version number.
   */
  private async deactivateFlow(developerName: string): Promise<boolean> {
    const flowDef = await this.queryFlowDefinition(developerName);
    if (!flowDef) {
      this.logger?.trace(`FlowActivation: flow '${developerName}' not found in org, skipping`);
      return false;
    }

    if (flowDef.ActiveVersion === null) {
      this.logger?.debug(`FlowActivation: flow '${developerName}' is already inactive, skipping`);
      return false;
    }

    await this.setActiveVersion(flowDef.Id, developerName, '');
    this.logger?.info(`FlowActivation: deactivated flow '${developerName}'`);
    return true;
  }

  // --------------------------------------------------------------------------
  // Tooling API Operations
  // --------------------------------------------------------------------------

  /**
   * Query a single `FlowDefinition` from the org by developer name.
   */
  private async queryFlowDefinition(developerName: string): Promise<FlowDefinitionRecord | undefined> {
    const query
      = 'SELECT Id, DeveloperName, '
        + 'ActiveVersion.VersionNumber, '
        + 'LatestVersion.VersionNumber, LatestVersionId '
        + `FROM FlowDefinition WHERE DeveloperName = '${escapeSOQL(developerName)}'`;

    try {
      const result = await this.connection.tooling.query<FlowDefinitionRecord>(query);
      return result.records?.[0];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`FlowActivation: error querying flow '${developerName}': ${message}`);
      return undefined;
    }
  }

  /**
   * Set the active version of a `FlowDefinition` via the Tooling API.
   *
   * @param id - The `FlowDefinition` Tooling API record Id
   * @param developerName - Used for logging / error messages
   * @param versionNumber - Version number to activate, or `''` to deactivate
   */
  private async setActiveVersion(
    id: string,
    developerName: string,
    versionNumber: number | string,
  ): Promise<void> {
    const payload = {
      Id: id,
      Metadata: {activeVersionNumber: versionNumber},
    } as {[key: string]: unknown; Id: string;};

    const result = await this.connection.tooling.sobject('FlowDefinition').update(payload);

    if (result && typeof result === 'object' && 'success' in result && !(result as {success: boolean}).success) {
      throw new Error(`FlowActivation: Tooling API rejected update for flow '${developerName}'`);
    }
  }
}
