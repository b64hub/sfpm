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

export {default as SandboxProvider} from './org/sandbox/sandbox-provider.js';
export {type SandboxPoolOrgRecord} from './org/sandbox/sandbox-provider.js';
export {
  DEFAULT_SANDBOX,
  type Sandbox,
  type SandboxCreateOptions,
  type SandboxDefaults,
  type SandboxLicenseType,
  type SandboxPoolInfo,
} from './org/sandbox/types.js';

export {
  type ActiveScratchOrgRecord,
  default as ScratchOrgProvider,
} from './org/scratch/scratch-org-provider.js';
export {
  DEFAULT_SCRATCH_ORG,
  type PoolScratchOrgCreateResult,
  type ScratchOrg,
  type ScratchOrgCreateResult,
  type ScratchOrgInfoRecord,
  type ScratchOrgRequest,
} from './org/scratch/types.js';

export {default as AuthService} from './org/services/auth-service.js';
export {default as DevHubService} from './org/services/devhub-service.js';

export {
  ORG_PHASES, type OrgPhase, PREPARE_PHASE, VALIDATE_PHASE,
} from './phases.js';

export {createPoolServices, type CreatePoolServicesOptions, type PoolServices} from './pool/pool-factory.js';

export {default as PoolFetcher, type PoolFetcherEvents} from './pool/pool-fetcher.js';

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

export {ArtifactPackageInstallTask, type ArtifactPackageInstallTaskOptions} from './pool/tasks/artifact-package-install-task.js';
export {DeploymentTask, type DeploymentTaskOptions} from './pool/tasks/deployment-task.js';

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
export {defineOrgConfig, type OrgConfig} from './types.js';

// Utilities
export {default as generatePassword} from './utils/password-generator.js';
export {default as setAlias} from './utils/set-alias.js';
