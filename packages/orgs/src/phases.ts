// ============================================================================
// Phase Constants owned by the orgs module
// ============================================================================

/**
 * Phase name constants for orgs-owned lifecycle phases.
 *
 * The lifecycle engine is phase-agnostic — it doesn't require phases to be
 * pre-registered. These constants exist to provide a single source of truth
 * for phase names used by the orgs module and any hooks that target them.
 */

/**
 * The 'prepare' phase — provisions ephemeral orgs (scratch orgs) for
 * development and CI use. Typically composed with pool management.
 *
 * Lifecycle: create/claim org -> install dependencies -> apply config
 *
 * Available timings: `pre`, `post`
 */
export const PREPARE_PHASE = 'prepare' as const;

/**
 * The 'validate' phase — deploys source to an ephemeral org to validate
 * that a package can be installed cleanly. Used in PR validation CI.
 *
 * Lifecycle: claim/create org -> install source -> run tests -> report
 *
 * Available timings: `pre`, `post`
 */
export const VALIDATE_PHASE = 'validate' as const;

/**
 * All phase name constants owned by the orgs module.
 */
export const ORG_PHASES = [PREPARE_PHASE, VALIDATE_PHASE] as const;

export type OrgPhase = typeof ORG_PHASES[number];
