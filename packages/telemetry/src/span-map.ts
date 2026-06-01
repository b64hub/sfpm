/**
 * Declarative mapping from typed event bus event pairs to OpenTelemetry spans.
 *
 * Each entry defines a start event, an end event, a unique span key derivation,
 * optional parent key resolution, and attribute extractors.
 */

export interface SpanMapping {
  /** Which bus to subscribe to: 'build', 'install', or 'orchestration' */
  bus: 'build' | 'install' | 'orchestration';
  /** Event name that ends the span */
  end: string;
  /** Extractor for span attributes from the end event */
  endAttributes?: (evt: Record<string, unknown>) => Record<string, boolean | number | string>;
  /** OTel span name (e.g. 'sfpm.orchestration') */
  name: string;
  /** Resolve parent span key from the start event — if undefined, span is a root */
  parentKey?: (evt: Record<string, unknown>) => string | undefined;
  /** Unique key for this span instance, derived from the start event */
  spanKey: (evt: Record<string, unknown>) => string;
  /** Event name that starts the span */
  start: string;
  /** Extractor for span attributes from the start event */
  startAttributes?: (evt: Record<string, unknown>) => Record<string, boolean | number | string>;
}

/**
 * Default span mappings for SFPM events.
 *
 * Granularity: orchestration root (when present) + per-package build/install spans.
 * Parent linking uses a fixed orchestration key — only one orchestration runs per
 * process. When no orchestration is active (e.g. turbo mode), build/install spans
 * become roots automatically.
 */
export const defaultSpanMappings: SpanMapping[] = [
  {
    bus: 'orchestration',
    end: 'complete',
    endAttributes: evt => ({
      'sfpm.orchestration.total_duration_ms': evt.totalDuration as number,
    }),
    name: 'sfpm.orchestration',
    spanKey: () => 'orchestration',
    start: 'start',
    startAttributes(evt) {
      const attrs: Record<string, boolean | number | string> = {
        'sfpm.orchestration.id': evt.orchestrationId as string,
        'sfpm.orchestration.include_dependencies': evt.includeDependencies as boolean,
        'sfpm.orchestration.total_levels': evt.totalLevels as number,
        'sfpm.orchestration.total_packages': evt.totalPackages as number,
      };

      const turboRunId = process.env.TURBO_RUN_ID;
      if (turboRunId) {
        attrs['turbo.run_id'] = turboRunId;
      }

      return attrs;
    },
  },
  {
    bus: 'build',
    end: 'complete',
    endAttributes: evt => ({
      'sfpm.build.skipped': (evt.skipped ?? false) as boolean,
      'sfpm.build.success': evt.success as boolean,
    }),
    name: 'sfpm.build',
    parentKey: () => 'orchestration',
    spanKey: evt => `build:${evt.packageName as string}`,
    start: 'start',
    startAttributes(evt) {
      const attrs: Record<string, boolean | number | string> = {
        'sfpm.package.name': evt.packageName as string,
        'sfpm.package.type': evt.packageType as string,
      };

      const turboRunId = process.env.TURBO_RUN_ID;
      if (turboRunId) {
        attrs['turbo.run_id'] = turboRunId;
      }

      const turboHash = process.env.TURBO_HASH;
      if (turboHash) {
        attrs['turbo.hash'] = turboHash;
      }

      return attrs;
    },
  },
  {
    bus: 'install',
    end: 'complete',
    endAttributes: evt => ({
      'sfpm.install.success': evt.success as boolean,
    }),
    name: 'sfpm.install',
    parentKey: () => 'orchestration',
    spanKey: evt => `install:${evt.packageName as string}`,
    start: 'start',
    startAttributes(evt) {
      const attrs: Record<string, boolean | number | string> = {
        'sfpm.package.name': evt.packageName as string,
      };

      const turboRunId = process.env.TURBO_RUN_ID;
      if (turboRunId) {
        attrs['turbo.run_id'] = turboRunId;
      }

      const turboHash = process.env.TURBO_HASH;
      if (turboHash) {
        attrs['turbo.hash'] = turboHash;
      }

      return attrs;
    },
  },
];
