import path from 'path';
import { Logger } from '../../types/logger.js';

// Use dynamic import for CommonJS module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let npmConfModule: any;

/**
 * Result of reading npm configuration for a package
 */
export interface NpmConfigResult {
    /** Registry URL for the package */
    registry: string;
    /** Auth token for the registry (if found) */
    authToken?: string;
    /** Whether a scoped registry was used */
    isScopedRegistry: boolean;
}

/**
 * Default npm registry URL
 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Lazily load the npm-conf module (CommonJS)
 */
async function loadNpmConf(): Promise<typeof npmConfModule> {
    if (!npmConfModule) {
        // @ts-expect-error - CommonJS module with default export
        npmConfModule = (await import('@pnpm/npm-conf')).default;
    }
    return npmConfModule;
}

/**
 * Read npm configuration for a package.
 * 
 * Handles:
 * - Global registry setting
 * - Scoped registry settings (e.g., @scope:registry=https://npm.pkg.github.com)
 * - Auth tokens from .npmrc (e.g., //npm.pkg.github.com/:_authToken=...)
 * - Environment variable expansion (e.g., ${GITHUB_TOKEN})
 * 
 * Configuration is loaded from (in order of precedence):
 * 1. Project .npmrc
 * 2. User .npmrc (~/.npmrc)
 * 3. Global .npmrc
 * 4. Environment variables (npm_config_*)
 * 
 * @param packageName - Package name (can be scoped like @org/package)
 * @param projectDirectory - Project directory for .npmrc lookup
 * @param logger - Optional logger
 * @returns NpmConfigResult with registry and auth token
 */
export async function readNpmConfig(
    packageName: string,
    projectDirectory: string,
    logger?: Logger
): Promise<NpmConfigResult> {
    try {
        const npmConf = await loadNpmConf();
        
        // Initialize npm-conf with the project directory as the prefix/cwd
        const result = npmConf({
            cwd: projectDirectory,
            prefix: projectDirectory,
        });
        
        const config = result.config;
        
        // Check for scoped registry first
        const scope = extractScope(packageName);
        let registry = DEFAULT_REGISTRY;
        let isScopedRegistry = false;
        
        if (scope) {
            // Look for @scope:registry setting
            const scopedRegistry = config.get(`${scope}:registry`);
            if (scopedRegistry) {
                registry = normalizeRegistryUrl(scopedRegistry);
                isScopedRegistry = true;
                logger?.debug(`Using scoped registry for ${scope}: ${registry}`);
            }
        }
        
        // Fall back to global registry if no scoped registry found
        if (!isScopedRegistry) {
            const globalRegistry = config.get('registry');
            if (globalRegistry) {
                registry = normalizeRegistryUrl(globalRegistry);
                logger?.debug(`Using global registry: ${registry}`);
            }
        }
        
        // Get auth token for the registry
        const authToken = getAuthToken(config, registry, logger);
        
        return {
            registry,
            authToken,
            isScopedRegistry,
        };
    } catch (error) {
        logger?.debug(
            `Failed to read npm config: ${error instanceof Error ? error.message : String(error)}`
        );
        
        // Return defaults on error
        return {
            registry: DEFAULT_REGISTRY,
            authToken: undefined,
            isScopedRegistry: false,
        };
    }
}

/**
 * Extract scope from package name (e.g., @org/package -> @org)
 */
function extractScope(packageName: string): string | undefined {
    if (packageName.startsWith('@')) {
        const slashIndex = packageName.indexOf('/');
        if (slashIndex > 0) {
            return packageName.substring(0, slashIndex);
        }
    }
    return undefined;
}

/**
 * Get auth token for a registry URL.
 * 
 * Looks for tokens in npm config format:
 * - //registry.example.com/:_authToken=...
 * - //registry.example.com/:_auth=...
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAuthToken(config: any, registryUrl: string, logger?: Logger): string | undefined {
    try {
        // Parse the registry URL to get the host/path
        const url = new URL(registryUrl);
        const registryPath = `//${url.host}${url.pathname}`.replace(/\/$/, '');
        
        // Try different auth key formats
        const authKeys = [
            `${registryPath}/:_authToken`,
            `${registryPath}:_authToken`,
            `//${url.host}/:_authToken`,
            `//${url.host}:_authToken`,
        ];
        
        for (const key of authKeys) {
            const token = config.get(key);
            if (token) {
                // Expand environment variables if present
                const expandedToken = expandEnvVars(token);
                logger?.debug(`Found auth token for ${url.host}`);
                return expandedToken;
            }
        }
        
        // Also check for _auth (base64 encoded)
        const authBasicKeys = [
            `${registryPath}/:_auth`,
            `//${url.host}/:_auth`,
        ];
        
        for (const key of authBasicKeys) {
            const auth = config.get(key);
            if (auth) {
                logger?.debug(`Found basic auth for ${url.host}`);
                // _auth is already base64 encoded, return as-is
                return expandEnvVars(auth);
            }
        }
        
        return undefined;
    } catch (error) {
        logger?.debug(`Failed to parse registry URL for auth: ${error}`);
        return undefined;
    }
}

/**
 * Expand environment variables in a string.
 * Supports ${VAR} and $VAR formats.
 */
function expandEnvVars(value: string): string {
    if (!value) return value;
    
    // Handle ${VAR} format
    let expanded = value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
        return process.env[varName] || '';
    });
    
    // Handle $VAR format (only if not already expanded)
    expanded = expanded.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, varName) => {
        return process.env[varName] || '';
    });
    
    return expanded;
}

/**
 * Normalize registry URL (ensure trailing slash removed, etc.)
 */
function normalizeRegistryUrl(url: string): string {
    return url.replace(/\/+$/, '');
}

/**
 * Synchronous version for cases where async isn't practical.
 * Note: This caches the module so first call may be slower.
 */
export function readNpmConfigSync(
    packageName: string,
    projectDirectory: string,
    logger?: Logger
): NpmConfigResult {
    try {
        // Use require for sync version - this will work after first async load
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const npmConf = require('@pnpm/npm-conf');
        
        const result = npmConf({
            cwd: projectDirectory,
            prefix: projectDirectory,
        });
        
        const config = result.config;
        
        const scope = extractScope(packageName);
        let registry = DEFAULT_REGISTRY;
        let isScopedRegistry = false;
        
        if (scope) {
            const scopedRegistry = config.get(`${scope}:registry`);
            if (scopedRegistry) {
                registry = normalizeRegistryUrl(scopedRegistry);
                isScopedRegistry = true;
            }
        }
        
        if (!isScopedRegistry) {
            const globalRegistry = config.get('registry');
            if (globalRegistry) {
                registry = normalizeRegistryUrl(globalRegistry);
            }
        }
        
        const authToken = getAuthToken(config, registry, logger);
        
        return {
            registry,
            authToken,
            isScopedRegistry,
        };
    } catch (error) {
        logger?.debug(
            `Failed to read npm config (sync): ${error instanceof Error ? error.message : String(error)}`
        );
        
        return {
            registry: DEFAULT_REGISTRY,
            authToken: undefined,
            isScopedRegistry: false,
        };
    }
}
