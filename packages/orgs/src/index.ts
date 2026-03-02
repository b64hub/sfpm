export {
  type OrgCreateOptions,
  type OrgProvider,
  type PoolOrgClaimer,
  type PoolOrgInspector,
  type PoolOrgProvisioner,
} from './org/org-provider.js';

export {
  isSandbox,
  isScratchOrg,
  type PoolOrg,
  type PoolOrgAuth,
  type PoolOrgInfo,
  type PoolOrgRecord,
  type PoolOrgUsage,
} from './org/pool-org.js';

export { default as SandboxProvider } from './org/sandbox/sandbox-provider.js';
export {
  DEFAULT_SANDBOX,
  type Sandbox,
  type SandboxCreateOptions,
  type SandboxCreateRequest,
  type SandboxCreateResult,
  type SandboxDefaults,
  type SandboxLicenseType,
  type SandboxPoolInfo,
} from './org/sandbox/types.js';

export {
  default as ScratchOrgProvider,
  type ActiveScratchOrgRecord,
  type ScratchOrgInfoRecord,
} from './org/scratch/scratch-org-provider.js';
export {
  DEFAULT_SCRATCH_ORG,
  type ScratchOrg,
  type ScratchOrgCreateOptions,
  type ScratchOrgCreateRequest,
  type ScratchOrgCreateResult,
} from './org/scratch/types.js';

export { default as AuthService } from './org/services/auth-service.js';
export { default as DevHubService } from './org/services/devhub-service.js';

export { ORG_PHASES, type OrgPhase, PREPARE_PHASE, VALIDATE_PHASE } from './phases.js';

export { createPoolServices, type CreatePoolServicesOptions, type PoolServices } from './pool/pool-factory.js';

export { default as PoolFetcher, type PoolFetcherEvents } from './pool/pool-fetcher.js';

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
  type PoolOrgTask,
  type PoolOrgTaskResult,
  type PoolProvisioningState,
  type PoolSizingConfig,
  type PostClaimAction,
  type SandboxPoolConfig,
  type ScratchOrgPoolConfig,
} from './pool/types.js';

// Config
export { defineOrgConfig, type OrgConfig } from './types.js';

// Utilities
export { default as generatePassword } from './utils/password-generator.js';
export { default as setAlias } from './utils/set-alias.js';
