// Org Provider
export {
  type OrgCreateOptions,
  type OrgProvider,
} from './org/org-provider.js';
export {default as OrgService} from './org/org-service.js';
export {
  isSandbox,
  isScratchOrg,
  type OrgType,
  type PoolOrg,
  type PoolOrgAuth,
  type PoolOrgInfo as PoolOrgPoolInfo,
} from './org/pool-org.js';

export {default as SandboxProvider} from './org/sandbox/sandbox-provider.js';
export {type Sandbox} from './org/sandbox/types.js';

// Sandbox types
export {
  DEFAULT_SANDBOX,
  type SandboxCreateRequest,
  type SandboxCreateResult,
  type SandboxDefaults,
  type SandboxLicenseType,
  type SandboxPoolInfo,
} from './org/sandbox/types.js';
export {default as ScratchOrgProvider} from './org/scratch/scratch-org-provider.js';
export {type ScratchOrg} from './org/scratch/types.js';
export {default as AuthService} from './org/services/auth-service.js';

// Services
export {
  type ActiveScratchOrgRecord,
  default as DevHubService,
  type ScratchOrgInfoRecord,
} from './org/services/devhub-service.js';

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

// Pool factory
export {
  createPoolServices,
  type CreatePoolServicesOptions,
  type PoolServices,
} from './pool/pool-factory.js';

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

// Pool-layer types
export {
  DEFAULT_POOL_SIZING,
  type PoolConfig,
  type PoolConfigBase,
  type PoolDeleteOptions,
  type PoolFetchOptions,
  type PoolOrgAuthenticator,
  type PoolOrgLoggerFactory,
  type PoolOrgRecord,
  type PoolOrgTask,
  type PoolOrgTaskResult,
  type PoolProvisioningState,
  type PoolSizingConfig,
  type PostClaimAction,
  type SandboxPoolConfig,
  type ScratchOrgPoolConfig,
} from './pool/types.js';

// Config
export {
  defineOrgConfig,
  type OrgConfig,
} from './types.js';

// Utilities
export {generatePassword} from './utils/password-generator.js';
