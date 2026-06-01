import type {PollingStrategy, WatcherJobType} from '../types/watcher.js';

import {ApexTestPollingStrategy} from './strategies/apex-test-strategy.js';
import {BuildPollingStrategy} from './strategies/build-strategy.js';
import {DeployPollingStrategy} from './strategies/deploy-strategy.js';

// ============================================================================
// Strategy Registry
// ============================================================================

/**
 * Static registry mapping job types to their polling strategy instances.
 *
 * Strategies are singletons — they hold no mutable state.
 */
const strategyMap = new Map<WatcherJobType, PollingStrategy>([
  ['build', new BuildPollingStrategy()],
  ['deploy', new DeployPollingStrategy()],
  ['test', new ApexTestPollingStrategy()],
]);

/**
 * Resolve the polling strategy for a given job type.
 *
 * @throws if the job type has no registered strategy
 */
export function resolveStrategy(jobType: WatcherJobType): PollingStrategy {
  const strategy = strategyMap.get(jobType);
  if (!strategy) {
    throw new Error(`No polling strategy registered for job type '${jobType}'`);
  }

  return strategy;
}

/**
 * List all registered job types.
 */
export function registeredJobTypes(): WatcherJobType[] {
  return [...strategyMap.keys()];
}
