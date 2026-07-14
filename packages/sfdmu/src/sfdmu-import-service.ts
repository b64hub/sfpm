import type {Logger} from '@b64hub/sfpm-core';

import {execSync, type ExecSyncOptions} from 'node:child_process';

import type {SfdmuRunOptions, SfdmuRunResult} from './types.js';

/**
 * Service that wraps the SFDMU CLI child process.
 *
 * Accepts fully-resolved {@link SfdmuRunOptions} and invokes `sf sfdmu run`,
 * returning a structured {@link SfdmuRunResult}. No event emitting — the
 * caller owns lifecycle events.
 */
export default class SfdmuImportService {
  constructor(private readonly logger?: Logger) {}

  public async run(options: SfdmuRunOptions, packageName: string): Promise<SfdmuRunResult> {
    const startTime = Date.now();

    const args = [
      `--sourceusername "${options.sourceusername}"`,
      `--targetusername "${options.targetusername}"`,
      `--path "${options.path}"`,
    ];

    if (options.apiVersion) args.push(`--apiversion "${options.apiVersion}"`);
    if (options.noprompt) args.push('--noprompt');
    if (options.concurrencyMode) args.push(`--concurrencymode "${options.concurrencyMode}"`);
    if (options.verbose) args.push('--verbose');

    const command = `sf sfdmu run ${args.join(' ')}`;

    const execOptions: ExecSyncOptions = {
      cwd: options.path,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600_000, // 10 minutes
    };

    this.logger?.debug(`[${packageName}] Executing: ${command}`);

    let rawOutput: string;

    try {
      rawOutput = execSync(command, execOptions) as string;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`SFDMU execution failed:\n${message}`);
    }

    const duration = Date.now() - startTime;
    return this.parseOutput(rawOutput, duration);
  }

  /**
   * Parse SFDMU CLI output to extract structured results.
   *
   * Best-effort: SFDMU has no structured JSON output mode. We extract what
   * we can and treat a clean process exit as overall success.
   */
  private parseOutput(rawOutput: string, duration: number): SfdmuRunResult {
    const objectResults: SfdmuRunResult['objectResults'] = [];
    let objectsProcessed = 0;

    for (const line of rawOutput.split('\n')) {
      // e.g. "Account -- Upserted: 150 records"
      const match = line.match(/(\w+)\s+--\s+(\w+):\s+(\d+)\s+records?/i);
      if (match) {
        objectsProcessed++;
        objectResults.push({
          errorMessage: undefined,
          objectName: match[1],
          operation: match[2] as any,
          recordsFailed: 0,
          recordsProcessed: Number.parseInt(match[3], 10),
          success: true,
        });
      }

      // e.g. "Account -- ERROR: ..."
      const errorMatch = line.match(/(\w+)\s+--\s+ERROR:\s+(.+)/i);
      if (errorMatch) {
        objectResults.push({
          errorMessage: errorMatch[2],
          objectName: errorMatch[1],
          operation: 'Readonly',
          recordsFailed: 0,
          recordsProcessed: 0,
          success: false,
        });
      }
    }

    return {
      duration,
      objectResults,
      objectsProcessed: objectsProcessed > 0 ? objectsProcessed : objectResults.length,
      rawOutput,
      success: !objectResults.some(r => !r.success),
    };
  }
}
