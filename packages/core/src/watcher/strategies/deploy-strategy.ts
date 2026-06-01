import type {Connection} from '@salesforce/core';
import type {MetadataApiDeployStatus} from '@salesforce/source-deploy-retrieve';

import {Org} from '@salesforce/core';

import type {
  DeployWatcherPayload,
  DeployWatcherResult,
  PollingStrategy,
  PollOutcome,
  WatcherAuth,
} from '../../types/watcher.js';

// ============================================================================
// DeployPollingStrategy
// ============================================================================

/**
 * Polls metadata deploy status for a Salesforce deployment.
 *
 * Uses `connection.metadata.checkDeployStatus()` to query the
 * deploy status by ID. The deploy must have been started externally
 * (e.g., via {@link MetadataDeployService.deploy()}).
 */
export class DeployPollingStrategy implements PollingStrategy<DeployWatcherPayload, DeployWatcherResult> {
  readonly defaultIntervalMs = 5000;
  readonly defaultTimeoutMs = 1_800_000; // 30 minutes
  readonly jobType = 'deploy' as const;

  async connect(auth: WatcherAuth): Promise<Connection> {
    const org = await Org.create({aliasOrUsername: auth.username});
    return org.getConnection();
  }

  async poll(
    connection: Connection,
    payload: DeployWatcherPayload,
  ): Promise<PollOutcome<DeployWatcherResult>> {
    const status = await connection.metadata.checkDeployStatus(
      payload.deployId,
      true,
    ) as unknown as MetadataApiDeployStatus;

    const deployed = status.numberComponentsDeployed ?? 0;
    const total = status.numberComponentsTotal ?? 0;

    if (!status.done) {
      return {
        message: `${deployed}/${total} components — ${status.status}`,
        status: 'pending',
      };
    }

    const result: DeployWatcherResult = {
      componentsDeployed: deployed,
      componentTotal: total,
      status: String(status.status),
    };

    // Extract test results if available
    const runTestResult = (status.details as Record<string, unknown>)?.runTestResult as Record<string, unknown> | undefined;
    if (runTestResult) {
      const testsTotal = Number(runTestResult.numTestsRun ?? 0);
      const testsFailed = Number(runTestResult.numFailures ?? 0);
      result.testsTotal = testsTotal;
      result.testsFailed = testsFailed;
      result.testsCompleted = testsTotal;
    }

    // Extract component errors
    const componentFailures = status.details?.componentFailures;
    if (componentFailures) {
      const failures = Array.isArray(componentFailures) ? componentFailures : [componentFailures];
      result.componentErrors = failures.length;
    }

    if (status.success) {
      return {result, status: 'completed'};
    }

    const errorParts: string[] = [];
    if (result.componentErrors) errorParts.push(`${result.componentErrors} component errors`);
    if (result.testsFailed) errorParts.push(`${result.testsFailed} test failures`);

    return {
      error: errorParts.length > 0 ? errorParts.join(', ') : 'Deployment failed',
      result,
      status: 'failed',
    };
  }
}
