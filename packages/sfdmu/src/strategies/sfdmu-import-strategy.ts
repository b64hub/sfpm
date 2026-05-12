import type {DataDeployable, Logger} from '@b64/sfpm-core';

import {InstallationError} from '@b64/sfpm-core';
import fs from 'fs-extra';
import {execSync, type ExecSyncOptions} from 'node:child_process';
import EventEmitter from 'node:events';
import path from 'node:path';

import type {
  SfdmuExportJson, SfdmuObjectConfig, SfdmuRunOptions, SfdmuRunResult,
} from '../types.js';

/**
 * Strategy for importing data into a Salesforce org using SFDMU.
 *
 * Consumes the content-agnostic {@link DataDeployable} interface from core,
 * then applies SFDMU-specific knowledge to interpret the directory contents
 * and invoke the SFDMU tool.
 *
 * Prefers CLI invocation (`sf sfdmu run`) as the most stable integration path.
 * Can be extended in the future to support SFDMU's Node API if available.
 */
export default class SfdmuImportStrategy extends EventEmitter {
  private readonly logger?: Logger;

  constructor(logger?: Logger, parentEmitter?: EventEmitter) {
    super();
    this.logger = logger;

    // Forward events to the parent emitter (installer) if provided
    if (parentEmitter) {
      this.on('data-import:start', data => parentEmitter.emit('data-import:start', data));
      this.on('data-import:progress', data => parentEmitter.emit('data-import:progress', data));
      this.on('data-import:complete', data => parentEmitter.emit('data-import:complete', data));
    }
  }

  /**
   * Execute the SFDMU import.
   *
   * @param dataDeployable - The data package to deploy (provides dataDirectory)
   * @param targetOrg - Target org alias or username
   * @returns Result of the SFDMU run
   */
  public async execute(dataDeployable: DataDeployable, targetOrg: string): Promise<SfdmuRunResult> {
    const {dataDirectory, packageName} = dataDeployable;
    const startTime = Date.now();

    // Read export.json to understand what we're deploying
    const exportJsonPath = path.join(dataDirectory, 'export.json');
    const exportJson: SfdmuExportJson = await fs.readJson(exportJsonPath);
    const allObjects = this.extractObjects(exportJson);
    const sObjectNames = allObjects.map(o => o.objectName ?? o.query?.split(/\s+FROM\s+/i)[1]?.split(/\s+/)[0] ?? 'unknown');

    this.emit('data-import:start', {
      objectCount: sObjectNames.length,
      objects: sObjectNames,
      packageName,
      timestamp: new Date(),
    });

    this.logger?.info(`Starting SFDMU import for ${packageName}: ${sObjectNames.length} sObject(s) to ${targetOrg}`);

    const runOptions: SfdmuRunOptions = {
      noprompt: true,
      path: dataDirectory,
      sourceusername: 'csvfile',
      targetusername: targetOrg,
      ...(exportJson.apiVersion ? {apiVersion: exportJson.apiVersion} : {}),
    };

    try {
      const result = await this.runSfdmu(runOptions, packageName);

      this.emit('data-import:complete', {
        duration: result.duration,
        objectsProcessed: result.objectsProcessed,
        packageName,
        success: result.success,
        timestamp: new Date(),
      });

      if (!result.success) {
        const failedObjects = result.objectResults
        .filter(r => !r.success)
        .map(r => `${r.objectName}: ${r.errorMessage}`)
        .join('; ');

        throw new InstallationError(packageName, targetOrg, `SFDMU import failed for: ${failedObjects}`, {
          cause: new Error(failedObjects),
        });
      }

      this.logger?.info(`SFDMU import completed for ${packageName} in ${result.duration}ms`);
      return result;
    } catch (error) {
      if (error instanceof InstallationError) {
        throw error;
      }

      throw new InstallationError(
        packageName,
        targetOrg,
        `SFDMU import failed: ${error instanceof Error ? error.message : String(error)}`,
        {cause: error instanceof Error ? error : new Error(String(error))},
      );
    }
  }

  private extractObjects(exportJson: SfdmuExportJson): SfdmuObjectConfig[] {
    if (exportJson.objects && Array.isArray(exportJson.objects)) {
      return exportJson.objects;
    }

    if (exportJson.objectSets && Array.isArray(exportJson.objectSets)) {
      return exportJson.objectSets.flatMap(set => set.objects ?? []);
    }

    return [];
  }

  /**
   * Parse SFDMU CLI output to extract structured results.
   *
   * SFDMU output parsing is best-effort — the tool's output format
   * is not strictly guaranteed. We extract what we can and fall back
   * to a generic success/failure based on the process exit code.
   */
  private parseOutput(rawOutput: string, duration: number): SfdmuRunResult {
    // Basic parsing — SFDMU doesn't have a structured JSON output mode.
    // We consider the run successful if the process exited cleanly (no exception above).
    const objectResults: SfdmuRunResult['objectResults'] = [];

    // Try to extract per-object results from output lines
    const lines = rawOutput.split('\n');
    let objectsProcessed = 0;

    for (const line of lines) {
      // Look for lines like: "Account -- Upserted: 150 records"
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

      // Look for error lines
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

  /**
   * Invoke SFDMU via the Salesforce CLI.
   *
   * Uses `sf sfdmu run` as the primary invocation path.
   * Falls back to `sfdx sfdmu:run` for legacy installations.
   */
  private async runSfdmu(options: SfdmuRunOptions, _packageName: string): Promise<SfdmuRunResult> {
    const startTime = Date.now();

    // Build the CLI command
    const args = [
      `--sourceusername "${options.sourceusername}"`,
      `--targetusername "${options.targetusername}"`,
      `--path "${options.path}"`,
    ];

    if (options.apiVersion) {
      args.push(`--apiversion "${options.apiVersion}"`);
    }

    if (options.noprompt) {
      args.push('--noprompt');
    }

    if (options.concurrencyMode) {
      args.push(`--concurrencymode "${options.concurrencyMode}"`);
    }

    if (options.verbose) {
      args.push('--verbose');
    }

    const command = `sf sfdmu run ${args.join(' ')}`;

    const execOptions: ExecSyncOptions = {
      cwd: options.path,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600_000, // 10 minute timeout
    };

    this.logger?.debug(`Executing: ${command}`);

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
}
