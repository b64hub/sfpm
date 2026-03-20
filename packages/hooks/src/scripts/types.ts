// ============================================================================
// Script Hook Options
// ============================================================================

/**
 * Supported script types for the script hook.
 */
export type ScriptType = 'apex' | 'javascript' | 'shell' | 'typescript';

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
   *
   * @example 'scripts/post-deploy.sh'
   * @example 'scripts/seed-data.ts'
   * @example 'scripts/anon.apex'
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
