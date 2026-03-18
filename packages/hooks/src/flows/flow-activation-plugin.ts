import {
  HookContext, LifecycleHooks, type Logger, PackageType,
} from '@b64/sfpm-core';
import {Connection, Org} from '@salesforce/core';

import type {FlowActivationHooksOptions, PackageFlowEntry} from './types.js';

import {FlowActivator} from './flow-activator.js';

// ============================================================================
// Source Component Contracts
// ============================================================================

/**
 * Minimal interface for SourceComponent — avoids importing SDR.
 */
interface SourceFlowLike {
  fullName: string;
  parseXmlSync(): Record<string, unknown>;
}

/**
 * Shape of a package that exposes flow SourceComponents.
 * Satisfied by `SfpmMetadataPackage`.
 */
interface FlowCapablePackage {
  flows: SourceFlowLike[];
  type: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Creates lifecycle hooks for activating / deactivating flows
 * post-deployment.
 *
 * Registers a hook on `install:post` that reads each flow's intended
 * status from the package source XML and adjusts the target org to
 * match:
 *
 * - **Active** flows → latest version is activated via the Tooling API.
 * - **Draft / Obsolete / InvalidDraft** flows → deactivated in the org.
 *
 * The hook reads flow components directly from the
 * `SfpmMetadataPackage.flows` getter (backed by the `ComponentSet`),
 * so no additional dependency on `@salesforce/source-deploy-retrieve`
 * is required.
 *
 * @param options - Hook configuration options
 * @returns A LifecycleHooks instance to pass to `defineConfig({ hooks: [...] })`
 *
 * @example
 * ```typescript
 * // sfpm.config.ts
 * import { defineConfig } from '@b64/sfpm-core';
 * import { flowActivationHooks } from '@b64/sfpm-hooks';
 *
 * export default defineConfig({
 *   hooks: [
 *     flowActivationHooks({ skipAlreadyActive: true }),
 *   ],
 * });
 * ```
 */
export function flowActivationHooks(options?: FlowActivationHooksOptions): LifecycleHooks {
  return {
    hooks: [
      {
        async handler(context: HookContext) {
          const {logger, packageName} = context;

          // ── Guard: skip data packages ─────────────────────────────
          const sfpmPackage = context.sfpmPackage as FlowCapablePackage | undefined;

          if (!sfpmPackage) {
            logger?.debug(`FlowActivation: no package model available for '${packageName}', skipping`);
            return;
          }

          if (String(sfpmPackage.type) === PackageType.Data) {
            logger?.debug(`FlowActivation: skipping '${packageName}' (data package)`);
            return;
          }

          // ── Guard: need an org connection ─────────────────────────
          const connection = resolveConnection(context, logger);
          if (!connection) {
            logger?.warn(`FlowActivation: no org connection available for '${packageName}', skipping`);
            return;
          }

          // ── Extract flow entries from the package model ───────────
          const entries = extractFlowEntries(sfpmPackage, options?.flowNames, logger);

          if (entries.length === 0) {
            logger?.debug(`FlowActivation: no flows found in '${packageName}'`);
            return;
          }

          logger?.info(`FlowActivation: processing ${entries.length} flow(s) for '${packageName}'`);

          // ── Activate / deactivate ─────────────────────────────────
          const activator = new FlowActivator(connection, options, logger);
          const {activated, deactivated} = await activator.processFlows(entries);

          if (activated > 0 || deactivated > 0) {
            logger?.info(`FlowActivation: activated ${activated}, deactivated ${deactivated} flow(s) for '${packageName}'`);
          } else {
            logger?.debug(`FlowActivation: all flows for '${packageName}' are already in sync`);
          }
        },
        phase: 'install',
        timing: 'post',
      },
    ],

    name: 'flow-activation',
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a Salesforce `Connection` from the hook context.
 */
function resolveConnection(
  context: HookContext,
  logger?: Logger,
): Connection | undefined {
  const {org} = context;

  if (org instanceof Org) {
    return org.getConnection();
  }

  logger?.debug('FlowActivation: context.org is not an Org instance');
  return undefined;
}

/**
 * Walk the package's flow components, parse their XML, and return
 * `PackageFlowEntry` items with each flow's developer name and
 * intended source status.
 */
function extractFlowEntries(
  sfpmPackage: FlowCapablePackage,
  flowNames: string[] | undefined,
  logger?: Logger,
): PackageFlowEntry[] {
  const flowComponents: SourceFlowLike[] = sfpmPackage.flows ?? [];
  const entries: PackageFlowEntry[] = [];
  const nameFilter = flowNames?.length ? new Set(flowNames) : undefined;

  for (const flow of flowComponents) {
    // Apply optional name filter
    if (nameFilter && !nameFilter.has(flow.fullName)) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = flow.parseXmlSync();
    } catch {
      logger?.trace(`FlowActivation: failed to parse XML for flow '${flow.fullName}', skipping`);
      continue;
    }

    const flowXml = parsed?.Flow as undefined | {status?: string};
    if (!flowXml?.status) {
      logger?.trace(`FlowActivation: flow '${flow.fullName}' has no status in XML, skipping`);
      continue;
    }

    entries.push({
      developerName: flow.fullName,
      sourceStatus: flowXml.status,
    });
  }

  return entries;
}
