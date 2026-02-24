export {default as OrgService} from './org/org-service.js';
export {type ScratchOrg} from './org/scratch/types.js';

// Services
export {
  type ActiveScratchOrgRecord,
  default as DevHubService,
  type ScratchOrgInfoRecord,
} from './org/services/devhub-service.js';
export {default as ScratchOrgAuthService} from './org/services/scratch-org-auth-service.js';

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

// Pool service
export {default as PoolService} from './pool/pool-service.js';

// Types and config
export {
  type AllocationStatus,
  type CreateScratchOrgOptions,
  DEFAULT_POOL_SIZING,
  DEFAULT_SCRATCH_ORG,
  defineOrgConfig,
  type DevHub,
  type JwtAuthConfig,
  type OrgConfig,
  OrgError,
  type OrgServiceEvents,
  type PasswordResult,
  type PoolArtifactFetchConfig,
  type PoolConfig,
  type PoolDeleteOptions,
  type PoolDeploymentConfig,
  type PoolFetchAllOptions,
  type PoolFetchOptions,
  type PoolInfoProvider,
  type PoolNetworkConfig,
  type PoolOrgAuthenticator,
  type PoolOrgLoggerFactory,
  type PoolOrgRecord,
  type PoolOrgProvider as PoolOrgSource,
  type PoolOrgTask,
  type PoolOrgTaskResult,
  type PoolPrerequisiteChecker,
  type PoolProvisioningState,
  type PoolScriptsConfig,
  type PoolSizingConfig,
  type ScratchOrgCreateRequest,
  type ScratchOrgCreateResult,
  type ScratchOrgDefaults,
  type ScratchOrgUsage,
  type SendEmailOptions,
  type ShareScratchOrgOptions,
} from './types.js';

// Utilities
export {generatePassword} from './utils/password-generator.js';
