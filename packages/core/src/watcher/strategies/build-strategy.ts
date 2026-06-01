import type {Connection} from '@salesforce/core';

import {Org} from '@salesforce/core';
import {PackageVersion} from '@salesforce/packaging';

import type {
  BuildWatcherPackageResult,
  BuildWatcherPayload,
  BuildWatcherResult,
  PollingStrategy,
  PollOutcome,
  WatcherAuth,
} from '../../types/watcher.js';

// ============================================================================
// BuildPollingStrategy
// ============================================================================

/**
 * Polls Package2VersionCreateRequest for unlocked package builds.
 *
 * Wraps the same `PackageVersion.getCreateStatus()` API used by
 * {@link ValidationPoller}, but as a single-check poll conforming
 * to the generic watcher strategy interface.
 *
 * Each `poll()` call checks ALL targets and returns:
 * - `pending` if any target is still in progress
 * - `completed` if all targets succeeded
 * - `failed` if any target errored (remaining results included)
 */
export class BuildPollingStrategy implements PollingStrategy<BuildWatcherPayload, BuildWatcherResult> {
  readonly defaultIntervalMs = 30_000;
  readonly defaultTimeoutMs = 7_200_000; // 120 minutes
  readonly jobType = 'build' as const;

  async connect(auth: WatcherAuth): Promise<Connection> {
    const org = await Org.create({aliasOrUsername: auth.username});
    return org.getConnection();
  }

  async poll(
    connection: Connection,
    payload: BuildWatcherPayload,
  ): Promise<PollOutcome<BuildWatcherResult>> {
    const results: BuildWatcherPackageResult[] = [];
    let anyPending = false;
    let anyFailed = false;
    let completedCount = 0;

    for (const target of payload.targets) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const status = await PackageVersion.getCreateStatus(
          target.packageVersionCreateRequestId,
          connection,
        );

        if (!status) {
          results.push({
            error: 'Creation request not found',
            packageName: target.packageName,
            packageVersionId: target.packageVersionId,
            status: 'Error',
          });
          anyFailed = true;
          continue;
        }

        if (status.Status === 'Success') {
          completedCount++;
          results.push({
            codeCoverage: typeof status.CodeCoverage === 'number' ? status.CodeCoverage : undefined,
            hasPassedCodeCoverageCheck: status.HasPassedCodeCoverageCheck ?? undefined,
            packageName: target.packageName,
            packageVersionId: status.SubscriberPackageVersionId ?? target.packageVersionId,
            status: 'Success',
          });
          continue;
        }

        if (status.Status === 'Error') {
          const errors = status.Error?.length
            ? status.Error.map((e: unknown) =>
              typeof e === 'string' ? e : ((e as {Message?: string}).Message ?? JSON.stringify(e))).join('; ')
            : 'Unknown error';

          results.push({
            error: errors,
            packageName: target.packageName,
            packageVersionId: status.SubscriberPackageVersionId ?? target.packageVersionId,
            status: 'Error',
          });
          anyFailed = true;
          continue;
        }

        // Queued, InProgress, Verifying — still pending
        anyPending = true;
      } catch {
        // Transient error — treat as pending so runner retries next cycle
        anyPending = true;
      }
    }

    if (anyPending) {
      return {
        message: `${completedCount}/${payload.targets.length} packages complete`,
        status: 'pending',
      };
    }

    const result: BuildWatcherResult = {packages: results};

    if (anyFailed) {
      const failedNames = results.filter(r => r.status === 'Error').map(r => r.packageName);
      return {
        error: `Build failed for: ${failedNames.join(', ')}`,
        result,
        status: 'failed',
      };
    }

    return {result, status: 'completed'};
  }
}
