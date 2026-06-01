import type {TestResult as ApexTestResult} from '@salesforce/apex-node';
import type {Connection} from '@salesforce/core';

import {TestService} from '@salesforce/apex-node';
import {Org} from '@salesforce/core';

import type {
  ApexTestWatcherPayload,
  ApexTestWatcherResult,
  PollingStrategy,
  PollOutcome,
  WatcherAuth,
} from '../../types/watcher.js';

// ============================================================================
// ApexTestPollingStrategy
// ============================================================================

/**
 * Polls an async Apex test run for completion using the
 * `@salesforce/apex-node` TestService SDK.
 *
 * Uses `AsyncTests.checkRunStatus()` for non-blocking progress checks
 * and `TestService.reportAsyncResults()` to retrieve full results
 * once the run is terminal.
 */
export class ApexTestPollingStrategy implements PollingStrategy<ApexTestWatcherPayload, ApexTestWatcherResult> {
  readonly defaultIntervalMs = 10_000;
  readonly defaultTimeoutMs = 3_600_000; // 60 minutes
  readonly jobType = 'test' as const;

  async connect(auth: WatcherAuth): Promise<Connection> {
    const org = await Org.create({aliasOrUsername: auth.username});
    return org.getConnection();
  }

  async poll(
    connection: Connection,
    payload: ApexTestWatcherPayload,
  ): Promise<PollOutcome<ApexTestWatcherResult>> {
    const testService = new TestService(connection);

    // Non-blocking status check via the SDK
    const {testRunSummary, testsComplete} = await testService.asyncService.checkRunStatus(payload.testRunId);

    if (!testsComplete) {
      const classesCompleted = testRunSummary.ClassesCompleted ?? 0;
      const classesTotal = testRunSummary.ClassesEnqueued ?? 0;
      return {
        message: `${classesCompleted}/${classesTotal} classes — ${testRunSummary.Status}`,
        status: 'pending',
      };
    }

    // Terminal — fetch full results with method-level details
    const fullResult = await testService.reportAsyncResults(payload.testRunId, true) as ApexTestResult;
    const methodsFailed = fullResult.summary.failing;
    const methodsPassed = fullResult.summary.passing;

    const result: ApexTestWatcherResult = {
      classesCompleted: testRunSummary.ClassesCompleted,
      classesFailed: undefined,
      methodsFailed,
      methodsPassed,
      status: testRunSummary.Status,
    };

    if (testRunSummary.Status === 'Completed' && methodsFailed === 0) {
      return {result, status: 'completed'};
    }

    return {
      error: methodsFailed > 0
        ? `${methodsFailed} test methods failed`
        : `Test run ${testRunSummary.Status}`,
      result,
      status: 'failed',
    };
  }
}
