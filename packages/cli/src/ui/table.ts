import type {WatcherStatus} from '@b64hub/sfpm-core';

import chalk from 'chalk';

import {formatDuration} from './renderer-utils.js';

// ============================================================================
// Status formatting
// ============================================================================

const STATUS_STYLES: Record<string, (text: string) => string> = {
  cancelled: chalk.gray,
  completed: chalk.green,
  error: chalk.red,
  polling: chalk.yellow,
  starting: chalk.cyan,
};

export function colorizeStatus(status: string | WatcherStatus): string {
  const styleFn = STATUS_STYLES[status] ?? chalk.gray;
  return styleFn(status);
}

// ============================================================================
// Age formatting
// ============================================================================

export function formatAge(ms: number): string {
  if (ms < 0) return '0s';
  return formatDuration(ms);
}

// ============================================================================
// Truncation
// ============================================================================

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}
