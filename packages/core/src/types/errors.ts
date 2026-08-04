/**
 * Utility function to preserve error chains
 */
export function preserveErrorChain(error: Error, cause?: Error): void {
  if (cause) {
    error.cause = cause;
    if (cause.stack) {
      error.stack = `${error.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/**
 * Error that occurs during package build process
 */
export class BuildError extends Error {
  public readonly buildStep?: string;
  public readonly context: Record<string, any>;
  public readonly packageName: string;
  public readonly timestamp: Date;

  constructor(
    packageName: string,
    message: string,
    options?: {
      buildStep?: string;
      cause?: Error;
      context?: Record<string, any>;
    },
  ) {
    super(message);
    this.name = 'BuildError';
    this.timestamp = new Date();
    this.context = options?.context || {};
    this.packageName = packageName;
    this.buildStep = options?.buildStep;

    preserveErrorChain(this, options?.cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BuildError);
    }
  }
}

/**
 * Error that occurs during package installation
 */
export class InstallationError extends Error {
  public readonly context: Record<string, any>;
  public readonly installationMode?: 'source-deploy' | 'version-install';
  public readonly installationStep?: string;
  public readonly packageName: string;
  public readonly packageVersion?: string;
  public readonly targetOrg: string;
  public readonly timestamp: Date;

  constructor(
    packageName: string,
    targetOrg: string,
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
      installationMode?: 'source-deploy' | 'version-install';
      installationStep?: string;
      packageVersion?: string;
    },
  ) {
    super(message);
    this.name = 'InstallationError';
    this.timestamp = new Date();
    this.context = options?.context || {};
    this.packageName = packageName;
    this.targetOrg = targetOrg;
    this.packageVersion = options?.packageVersion;
    this.installationStep = options?.installationStep;
    this.installationMode = options?.installationMode;

    preserveErrorChain(this, options?.cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InstallationError);
    }
  }
}

/**
 * Error that occurs during artifact operations
 */
export class ArtifactError extends Error {
  public readonly context: Record<string, any>;
  public readonly operation: 'assembly' | 'download' | 'extract' | 'pack' | 'read' | 'resolve' | 'update' | 'validate' | 'write';
  public readonly packageName: string;
  public readonly timestamp: Date;
  public readonly version?: string;

  constructor(
    packageName: string,
    operation: 'assembly' | 'download' | 'extract' | 'pack' | 'read' | 'resolve' | 'update' | 'validate' | 'write',
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
      version?: string;
    },
  ) {
    super(message);
    this.name = 'ArtifactError';
    this.timestamp = new Date();
    this.context = options?.context || {};
    this.packageName = packageName;
    this.operation = operation;
    this.version = options?.version;

    preserveErrorChain(this, options?.cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ArtifactError);
    }
  }
}

/**
 * Error that occurs during dependency resolution
 */
export class DependencyError extends Error {
  public readonly context: Record<string, any>;
  public readonly missingDependencies: string[];
  public readonly packageName: string;
  public readonly timestamp: Date;

  constructor(
    packageName: string,
    missingDependencies: string[],
    message?: string,
    options?: {
      cause?: Error;
      context?: Record<string, any>;
    },
  ) {
    super(message || `Package ${packageName} has unresolved dependencies`);
    this.name = 'DependencyError';
    this.timestamp = new Date();
    this.context = options?.context || {};
    this.packageName = packageName;
    this.missingDependencies = missingDependencies;

    preserveErrorChain(this, options?.cause);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DependencyError);
    }
  }
}
