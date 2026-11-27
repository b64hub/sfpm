import {PoolStage} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';

import PoolDelete from './delete.js';

/**
 * Convenience wrapper around `pool delete` for the common "refill the pool"
 * workflow: by default it only deletes `Available` orgs, leaving `Assigned`
 * (in use by a developer) and `InProgress` (still provisioning) alone.
 * Pass `--exclude-stage` to override which stages are protected.
 */
export default class PoolClean extends PoolDelete {
  static override description = 'delete only available orgs from a pool (safe to run before refilling — never touches assigned or in-progress orgs by default)'
  static override examples = [
    '<%= config.bin %> pool clean --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool clean --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool clean --tag dev-pool -v my-devhub --exclude-stage Assigned',
    '<%= config.bin %> pool clean --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    ...PoolDelete.flags,
    'exclude-stage': Flags.string({
      default: [PoolStage.Assigned, PoolStage.InProgress],
      description: 'exclude orgs in this pool stage from deletion (repeat for multiple; default: Assigned, InProgress — only Available orgs are cleaned)',
      multiple: true,
      options: [PoolStage.Assigned, PoolStage.Available, PoolStage.InProgress],
    }),
  }
}
