import type {Diagnostic, ValidationResult} from '../../types/validator.js';

interface NimbusValidateFile {
  errors?: {column: number; line: number; message: string}[];
  file: string;
  valid: boolean;
}
interface NimbusValidateOutput {
  errorFiles: number;
  files: NimbusValidateFile[];
  totalFiles: number;
  validFiles: number;
}

export function parseNimbusValidateJson(
  stdout: string,
  stderr: string,
  exitCode: number,
  durationMs: number,
): ValidationResult {
  let parsed: NimbusValidateOutput;
  try {
    parsed = JSON.parse(stdout) as NimbusValidateOutput;
  } catch {
    return fallbackResult('compile', exitCode, stdout, stderr, durationMs);
  }

  const diagnostics: Diagnostic[] = parsed.files
  .filter(f => !f.valid)
  .flatMap(f =>
    (f.errors ?? []).map((e): Diagnostic => ({
      column: e.column,
      filePath: f.file,
      line: e.line,
      message: e.message,
      severity: 'error',
    })));

  return {
    capability: 'compile',
    diagnostics,
    durationMs,
    raw: {exitCode, stderr, stdout},
    status: parsed.errorFiles === 0 ? 'passed' : 'failed',
  };
}

// NOTE: the real "passed" fixture has no failing tests, so the shape of a
// failing test entry (message/line fields) is UNCONFIRMED. Treat as optional
// and degrade gracefully — do not throw if absent.
interface NimbusTestCase {
  class: string;
  duration_ms: number;
  line?: number;
  message?: string;
  method: string;
  status: 'failed' | 'passed' | 'skipped';
}
interface NimbusTestOutput {
  parse_errors: string[];
  status: 'failed' | 'passed';
  summary: {duration_ms: number; failed: number; passed: number; skipped: number; total: number;};
  tests: NimbusTestCase[];
  warnings: string[];
}

export function parseNimbusTestJson(
  stdout: string,
  stderr: string,
  exitCode: number,
  durationMs: number,
): ValidationResult {
  let parsed: NimbusTestOutput;
  try {
    parsed = JSON.parse(stdout) as NimbusTestOutput;
  } catch {
    return fallbackResult('test', exitCode, stdout, stderr, durationMs);
  }

  const diagnostics: Diagnostic[] = [
    ...parsed.tests
    .filter(t => t.status === 'failed')
    .map((t): Diagnostic => ({
      filePath: t.class,
      line: t.line,
      message: `${t.class}.${t.method}: ${t.message ?? 'failed'}`,
      severity: 'error',
    })),
    ...parsed.warnings.map((w): Diagnostic => ({message: w, severity: 'warning'})),
    ...parsed.parse_errors.map((e): Diagnostic => ({message: e, severity: 'error'})),
  ];

  return {
    capability: 'test',
    diagnostics,
    durationMs: parsed.summary.duration_ms,
    raw: {exitCode, stderr, stdout},
    status: parsed.status,
  };
}

function fallbackResult(
  capability: 'compile' | 'test',
  exitCode: number,
  stdout: string,
  stderr: string,
  durationMs: number,
): ValidationResult {
  return {
    capability,
    diagnostics: [
      {
        message: 'Could not parse nimbus --json output; falling back to exit code',
        severity: 'warning',
      },
    ],
    durationMs,
    raw: {exitCode, stderr, stdout},
    status: exitCode === 0 ? 'passed' : 'failed',
  };
}
