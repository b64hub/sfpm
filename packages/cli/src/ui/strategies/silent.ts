import type {CompleteSummary, DisplayStrategy} from './display-strategy.js';

// ============================================================================
// Silent Display Strategy (JSON mode)
// ============================================================================

/**
 * No-op display strategy for JSON mode.
 * All stdout is suppressed during execution — the base class emits
 * the JSON envelope after the command completes.
 */
export class SilentDisplay implements DisplayStrategy {
  complete(_summary: CompleteSummary): void {}

  error(_error: Error): void {}

  info(_message: string): void {}

  levelStart(_level: number, _packages: string[]): void {}

  packageComplete(_packageName: string, _duration: string): void {}

  packageFail(_packageName: string, _error?: string): void {}

  packageSkip(_packageName: string, _reason: string): void {}

  packageStart(_packageName: string): void {}

  start(_title: string, _packages: string[]): void {}

  subtaskComplete(_packageName: string, _phase: string, _detail?: string): void {}

  subtaskSkip(_packageName: string, _phase: string): void {}

  subtaskStart(_packageName: string, _phase: string): void {}

  subtaskUpdate(_packageName: string, _phase: string, _status: string): void {}

  warn(_message: string): void {}
}
