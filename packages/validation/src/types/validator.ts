import type {ValidationContext} from './validation-context.js';

export type ValidationCapability = 'compile' | 'test';

export interface AvailabilityResult {
  available: boolean;
  compatible?: boolean;
  reason?: string;
  remediation?: string;
  version?: string;
}

export interface Diagnostic {
  column?: number;
  filePath?: string;
  line?: number;
  message: string;
  severity: 'error' | 'info' | 'warning';
}

export interface ValidationResult {
  capability: ValidationCapability;
  diagnostics: Diagnostic[];
  durationMs: number;
  raw?: {exitCode: number; stderr: string; stdout: string;};
  status: 'error' | 'failed' | 'passed' | 'skipped';
}

export interface Validator {
  readonly capabilities: ValidationCapability[];
  checkAvailability(context: Pick<ValidationContext, 'packageId'>): Promise<AvailabilityResult>;
  readonly name: string;
  run(capability: ValidationCapability, context: ValidationContext): Promise<ValidationResult>;
}
