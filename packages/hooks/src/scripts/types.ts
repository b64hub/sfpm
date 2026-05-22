import type {Logger} from '@b64hub/sfpm-core';

// ============================================================================
// Script Hook Options
// ============================================================================

/**
 * Supported script types for the script hook.
 */
export type ScriptType = 'apex' | 'javascript' | 'npm' | 'shell' | 'typescript';

/**
 * Defines a single script to execute.
 */
export interface ScriptDefinition {
  /**
   * Environment variables to inject when running the script.
   */
  env?: Record<string, string>;

  /**
   * Optional filter: only execute for this specific package name.
   * When omitted, the script runs for all packages.
   */
  packageName?: string;

  /**
   * Path to the script file, relative to the project root.
   * For npm scripts (`type: 'npm'`), the name of the script in `package.json`.
   *
   * @example 'scripts/post-deploy.sh'
   * @example 'scripts/seed-data.ts'
   * @example 'scripts/anon.apex'
   * @example 'seed-data' // npm script name when type is 'npm'
   */
  path: string;

  /**
   * Restrict this script to specific lifecycle stages.
   * When omitted, the script runs on **all** stages.
   *
   * @example `['deploy', 'local']` — skip during validate and provision
   */
  stages?: string[];

  /**
   * Timeout in milliseconds. Defaults to 5 minutes.
   * @default 300_000
   */
  timeout?: number;

  /**
   * When to run this script relative to installation.
   * - `'pre'`  — before deployment
   * - `'post'` — after deployment (default)
   *
   * @default 'post'
   */
  timing?: 'post' | 'pre';

  /**
   * Script type. When omitted, inferred from the file extension:
   * - `.sh` → `'shell'`
   * - `.ts` → `'typescript'`
   * - `.js` → `'javascript'`
   * - `.apex` → `'apex'`
   *
   * Use `'npm'` to run an npm script from `package.json`.
   */
  type?: ScriptType;
}

/**
 * Configuration options for the script execution lifecycle hook.
 *
 * Supports shell scripts, TypeScript, JavaScript, and anonymous Apex
 * scripts to be run before or after package installation.
 */
export interface ScriptHooksOptions {
  /**
   * Whether to abort the pipeline if a script fails.
   * @default true
   */
  failOnError?: boolean;

  /**
   * Scripts to execute. Each script defines its path, type, and timing.
   */
  scripts: ScriptDefinition[];
}

// ============================================================================
// Script Execution
// ============================================================================

export interface ScriptResult {
  /** Combined stderr output. */
  stderr: string;
  /** Combined stdout output. */
  stdout: string;
  /** Whether the script completed successfully (exit code 0). */
  success: boolean;
}

/**
 * Contextual information passed to each {@link ScriptExecutor}.
 */
export interface ScriptExecutionContext {
  /** Custom per-script variables from {@link ScriptDefinition.env}. */
  custom?: Record<string, string>;
  /** The package name being installed. */
  packageName?: string;
  /** Absolute path to the package directory. */
  packagePath: string;
  /** The project root directory. */
  projectDir: string;
  /** The staging directory for the deployment. */
  stagingDirectory?: string;
  /** The target org alias or username. */
  targetOrg?: string;
}

/**
 * Strategy interface for executing a specific type of script.
 *
 * Each script type (shell, TypeScript, JavaScript, Apex, npm) has its
 * own executor implementation that handles command building, validation,
 * and CWD resolution.
 */
export interface ScriptExecutor {
  execute(
    script: ScriptDefinition,
    context: ScriptExecutionContext,
    logger?: Logger,
  ): Promise<ScriptResult>;
}
