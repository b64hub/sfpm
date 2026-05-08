import {ConfigAggregator, Org} from '@salesforce/core';
import chalk from 'chalk';
import ora, {type Ora} from 'ora';

import type {OutputMode} from './renderer-utils.js';

/**
 * Options for `connectDevHub()`.
 */
export interface ConnectDevHubOptions {
  /** The alias/username passed via --target-dev-hub flag */
  alias?: string;
  /** Output mode — spinner only shown in 'interactive' */
  mode: OutputMode;
  /**
   * Optional validation steps to run after connecting.
   * Each step updates the spinner text and runs an async check.
   * If a step throws, the spinner fails and the error propagates.
   */
  validate?: Array<{label: string; run: (devhub: Org) => Promise<void>}>;
}

/**
 * Result from `connectDevHub()`.
 */
export interface ConnectDevHubResult {
  /** The resolved alias/username used */
  alias: string;
  /** The authenticated Org instance */
  devhub: Org;
}

/**
 * Resolve a DevHub org from alias/flag or sf config, with spinner feedback.
 *
 * Handles the full flow:
 * 1. Resolve alias from flag or `ConfigAggregator`
 * 2. Show connecting spinner
 * 3. Authenticate via `Org.create()`
 * 4. Run optional validation steps (updating spinner text)
 * 5. Succeed/fail spinner
 *
 * @throws Error if no alias is resolved or connection/validation fails
 */
export async function connectDevHub(options: ConnectDevHubOptions): Promise<ConnectDevHubResult> {
  const {mode, validate} = options;

  // 1. Resolve alias
  let {alias} = options;
  if (!alias) {
    const configAggregator = await ConfigAggregator.create();
    alias = configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined;
  }

  if (!alias) {
    throw new Error('A target dev hub is required. Specify one with --target-dev-hub (-v) or set a default with: sf config set target-dev-hub=<username>');
  }

  // 2. Spinner
  const spinner: Ora | undefined = mode === 'interactive'
    ? ora(`Connecting to ${chalk.cyan(alias)}...`).start()
    : undefined;

  try {
    // 3. Connect
    const devhub = await Org.create({aliasOrUsername: alias});

    // 4. Validations
    if (validate) {
      for (const step of validate) {
        if (spinner) spinner.text = step.label;
        // eslint-disable-next-line no-await-in-loop -- sequential validation steps
        await step.run(devhub);
      }
    }

    // 5. Success
    spinner?.succeed(`Connected to ${chalk.cyan(alias)}`);

    return {alias, devhub};
  } catch (error) {
    spinner?.fail('Failed');
    throw error;
  }
}
