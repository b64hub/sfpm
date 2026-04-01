// ============================================================================
// Well-Known Lifecycle Stages
// ============================================================================

/**
 * Well-known lifecycle stage constants.
 *
 * These are convenience values for common stages. The lifecycle engine is
 * fully stage-agnostic — any string is a valid stage. These constants exist
 * purely for discoverability and to avoid magic strings in consumer code.
 *
 * @example
 * ```typescript
 * import { LifecycleEngine, Stages } from '@b64/sfpm-core';
 *
 * const lifecycle = new LifecycleEngine({ stage: Stages.VALIDATE });
 * ```
 */
export const Stages = {
  /** Local or CI build (`sfpm build`) */
  BUILD: 'build',
  /** Deployment to a persistent environment (DEV, SIT, UAT, PROD) */
  DEPLOY: 'deploy',
  /** Interactive developer usage (`sfpm install` from CLI) — the default stage */
  LOCAL: 'local',
  /** Scratch org creation / pool replenishment */
  PROVISION: 'provision',
  /** PR validation against a scratch org */
  VALIDATE: 'validate',
} as const;

/**
 * Union of well-known stage values.
 * Accepts any string to support custom stages.
 */
export type Stage = (typeof Stages)[keyof typeof Stages];

/** The default stage when none is provided. */
export const DEFAULT_STAGE: Stage = Stages.LOCAL;
