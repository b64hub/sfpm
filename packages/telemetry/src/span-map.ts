/**
 * Declarative mapping from EventEmitter event pairs to OpenTelemetry spans.
 *
 * Each entry defines a start event, an end event, a unique span key derivation,
 * optional parent key resolution, and attribute extractors.
 */

export interface SpanMapping {
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
 * Default span mappings for SFPM orchestration events.
 *
 * Initial granularity: orchestration root + per-package build/install spans.
 */
export const defaultSpanMappings: SpanMapping[] = [
  {
    end: 'orchestration:complete',
    endAttributes: evt => ({
      'sfpm.orchestration.total_duration_ms': evt.totalDuration as number,
    }),
    name: 'sfpm.orchestration',
    spanKey: evt => `orchestration:${evt.orchestrationId as string}`,
    start: 'orchestration:start',
    startAttributes: evt => ({
      'sfpm.orchestration.id': evt.orchestrationId as string,
      'sfpm.orchestration.include_dependencies': evt.includeDependencies as boolean,
      'sfpm.orchestration.total_levels': evt.totalLevels as number,
      'sfpm.orchestration.total_packages': evt.totalPackages as number,
    }),
  },
  {
    end: 'build:complete',
    endAttributes: evt => ({
      'sfpm.build.skipped': (evt.skipped ?? false) as boolean,
      'sfpm.build.success': evt.success as boolean,
    }),
    name: 'sfpm.build',
    parentKey: evt => evt.orchestrationId ? `orchestration:${evt.orchestrationId as string}` : undefined,
    spanKey: evt => `build:${evt.orchestrationId as string}:${evt.packageName as string}`,
    start: 'build:start',
    startAttributes: evt => ({
      'sfpm.package.name': evt.packageName as string,
      'sfpm.package.type': evt.packageType as string,
    }),
  },
  {
    end: 'install:complete',
    endAttributes: evt => ({
      'sfpm.install.success': evt.success as boolean,
    }),
    name: 'sfpm.install',
    parentKey: evt => evt.orchestrationId ? `orchestration:${evt.orchestrationId as string}` : undefined,
    spanKey: evt => `install:${evt.orchestrationId as string}:${evt.packageName as string}`,
    start: 'install:start',
    startAttributes: evt => ({
      'sfpm.package.name': evt.packageName as string,
    }),
  },
];
