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
  /** External ID field for upsert operations */
  externalId?: string;
  /** Field mapping overrides */
  fieldMapping?: Record<string, string>;
  /** The sObject API name (e.g., "Account", "Contact") */
  objectName: string;
  /** Operation to perform: Insert, Update, Upsert, Delete, etc. */
  operation: SfdmuOperation;
  /** SOQL query for filtering records */
  query: string;
  /** Whether to use CSV file as the data source for this object */
  useCSVValuesMapping?: boolean;
}

/**
 * An object set groups related sObject configurations together.
 * SFDMU processes each set sequentially.
 */
export interface SfdmuObjectSet {
  objects: SfdmuObjectConfig[];
}

/**
 * Root structure of SFDMU's export.json configuration file.
 *
 * Supports two formats:
 * - Flat: top-level `objects` array
 * - Grouped: top-level `objectSets` array, each containing an `objects` array
 */
export interface SfdmuExportJson {
  /** Allow field truncation on deploy */
  allOrNone?: boolean;
  /** API version to use for Salesforce calls */
  apiVersion?: string;
  /** Concurrency mode for Bulk API */
  bulkApiV1BatchSize?: number;
  /** Bulk API threshold — switch to Bulk API when record count exceeds this */
  bulkThreshold?: number;
  /** Whether to create target sObjects if they don't exist */
  createTargetCSVFiles?: boolean;
  /** Flat format: array of sObject configurations */
  objects?: SfdmuObjectConfig[];
  /** Grouped format: array of object sets, each with its own objects array */
  objectSets?: SfdmuObjectSet[];
  /** Polling interval in ms for async operations */
  pollingIntervalMs?: number;
}

/**
 * SFDMU operation types.
 */
export type SfdmuOperation
  = | 'Delete'
    | 'DeleteHierarchy'
    | 'DeleteSource'
    | 'HardDelete'
    | 'Insert'
    | 'Merge'
    | 'Readonly'
    | 'Update'
    | 'Upsert';

/**
 * Options for running the SFDMU import strategy.
 */
export interface SfdmuRunOptions {
  /** API version override */
  apiVersion?: string;
  /** Concurrency mode override */
  concurrencyMode?: 'Parallel' | 'Serial';
  /** Whether to suppress prompts */
  noprompt?: boolean;
  /** Absolute path to the directory containing export.json and CSV files */
  path: string;
  /** Source: "csvfile" for CSV-to-org, or an org alias for org-to-org */
  sourceusername: string;
  /** Target org alias or username */
  targetusername: string;
  /** Verbose output */
  verbose?: boolean;
}

/**
 * Result of an SFDMU run.
 */
export interface SfdmuRunResult {
  /** Duration in milliseconds */
  duration: number;
  /** Per-object results */
  objectResults: SfdmuObjectResult[];
  /** Number of sObjects processed */
  objectsProcessed: number;
  /** Raw output from the SFDMU process */
  rawOutput?: string;
  /** Whether the run completed successfully */
  success: boolean;
}

/**
 * Per-object result from an SFDMU run.
 */
export interface SfdmuObjectResult {
  errorMessage?: string;
  objectName: string;
  operation: SfdmuOperation;
  recordsFailed: number;
  recordsProcessed: number;
  success: boolean;
}
