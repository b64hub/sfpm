import type {PoolOrg} from '../pool-org.js';

/**
 * A scratch org managed by a pool.
 *
 * Extends `PoolOrg` with a fixed `kind` discriminant.  Scratch orgs
 * share the same pool metadata shape as the base — no additional
 * fields are needed.
 */
export interface ScratchOrg extends PoolOrg {
  readonly kind: 'scratchOrg';
}
