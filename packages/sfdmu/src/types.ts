/**
 * SFDMU-specific type definitions.
 *
 * These types model the SFDMU tool's configuration and execution concerns.
 * They are intentionally confined to this adapter package and never leak into core.
 */

/**
 * Represents a single sObject entry in SFDMU's export.json.
 */
export interface SfdmuObjectConfig {
  /** The sObject API name (e.g., "Account", "Contact") */
  objectName: string;
  /** SOQL query for filtering records */
  query: string;
  /** Operation to perform: Insert, Update, Upsert, Delete, etc. */
  operation: SfdmuOperation;
  /** External ID field for upsert operations */
  externalId?: string;
  /** Whether to use CSV file as the data source for this object */
  useCSVValuesMapping?: boolean;
  /** Field mapping overrides */
  fieldMapping?: Record<string, string>;
}

/**
 * Root structure of SFDMU's export.json configuration file.
 */
export interface SfdmuExportJson {
  /** Array of sObject configurations defining what data to move */
  objects: SfdmuObjectConfig[];
  /** Polling interval in ms for async operations */
  pollingIntervalMs?: number;
  /** Bulk API threshold — switch to Bulk API when record count exceeds this */
  bulkThreshold?: number;
  /** API version to use for Salesforce calls */
  apiVersion?: string;
  /** Whether to create target sObjects if they don't exist */
  createTargetCSVFiles?: boolean;
  /** Concurrency mode for Bulk API */
  bulkApiV1BatchSize?: number;
  /** Allow field truncation on deploy */
  allOrNone?: boolean;
}

/**
 * SFDMU operation types.
 */
export type SfdmuOperation =
  | 'Insert'
  | 'Update'
  | 'Upsert'
  | 'Merge'
  | 'Delete'
  | 'DeleteSource'
  | 'DeleteHierarchy'
  | 'HardDelete'
  | 'Readonly';

/**
 * Options for running the SFDMU import strategy.
 */
export interface SfdmuRunOptions {
  /** Absolute path to the directory containing export.json and CSV files */
  path: string;
  /** Target org alias or username */
  targetusername: string;
  /** Source: "csvfile" for CSV-to-org, or an org alias for org-to-org */
  sourceusername: string;
  /** API version override */
  apiVersion?: string;
  /** Verbose output */
  verbose?: boolean;
  /** Concurrency mode override */
  concurrencyMode?: 'Serial' | 'Parallel';
  /** Whether to suppress prompts */
  noprompt?: boolean;
}

/**
 * Result of an SFDMU run.
 */
export interface SfdmuRunResult {
  /** Whether the run completed successfully */
  success: boolean;
  /** Number of sObjects processed */
  objectsProcessed: number;
  /** Per-object results */
  objectResults: SfdmuObjectResult[];
  /** Raw output from the SFDMU process */
  rawOutput?: string;
  /** Duration in milliseconds */
  duration: number;
}

/**
 * Per-object result from an SFDMU run.
 */
export interface SfdmuObjectResult {
  objectName: string;
  operation: SfdmuOperation;
  recordsProcessed: number;
  recordsFailed: number;
  success: boolean;
  errorMessage?: string;
}
