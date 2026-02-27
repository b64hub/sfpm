export {default as OrgService} from './org/org-service.js';
export {type ScratchOrg} from './org/scratch/types.js';

// Services
export {
  type ActiveScratchOrgRecord,
  default as DevHubService,
  type ScratchOrgInfoRecord,
} from './org/services/devhub-service.js';
export {default as ScratchOrgAuthService} from './org/services/scratch-org-auth-service.js';

// Org-layer types
export {
  type AllocationStatus,
  type CreateScratchOrgOptions,
  DEFAULT_SCRATCH_ORG,
  type DevHub,
  type JwtAuthConfig,
  OrgError,
  type OrgServiceEvents,
  type PasswordResult,
  type ScratchOrgCreateRequest,
  type ScratchOrgCreateResult,
  type ScratchOrgDefaults,
  type ScratchOrgUsage,
  type SendEmailOptions,
  type ShareScratchOrgOptions,
} from './org/types.js';

export {
  ORG_PHASES,
  type OrgPhase,
  PREPARE_PHASE,
  VALIDATE_PHASE,
} from './phases.js';

// Pool fetcher
export {
  default as PoolFetcher,
  type PoolFetcherEvents,
} from './pool/pool-fetcher.js';

// Pool manager
export {
  computeOrgAllocation,
  type OrgProvisionResult,
  type OrgTaskSummary,
  type PoolAllocation,
  type PoolDeleteResult,
  default as PoolManager,
  type PoolManagerEvents,
  type PoolManagerOptions,
  type PoolProvisionResult,
} from './pool/pool-manager.js';

// Pool factory
export {
  createPoolServices,
  type CreatePoolServicesOptions,
  type PoolServices,
} from './pool/pool-factory.js';

// Pool-layer types
export {
  DEFAULT_POOL_SIZING,
  type PoolConfig,
  type PoolDeleteOptions,
  type PoolFetchOptions,
  type PoolOrgAuthenticator,
  type PoolOrgLoggerFactory,
  type PoolOrgProvider,
  type PoolOrgRecord,
  type PoolOrgProvider as PoolOrgSource,
  type PoolOrgTask,
  type PoolOrgTaskResult,
  type PostClaimAction,
  type PoolProvisioningState,
  type PoolSizingConfig,
} from './pool/types.js';

// Config
export {
  defineOrgConfig,
  type OrgConfig,
} from './types.js';

// Utilities
export {generatePassword} from './utils/password-generator.js';
