/**
 * Registry client interfaces and implementations for interacting with package registries.
 * 
 * @example
 * ```typescript
 * import { NpmRegistryClient, RegistryClient, readNpmConfig } from './registry';
 * 
 * // Read npm config for scoped registry and auth
 * const config = await readNpmConfig('@myorg/package', '/path/to/project');
 * 
 * const client: RegistryClient = new NpmRegistryClient({
 *     registryUrl: config.registry,
 *     authToken: config.authToken,
 * });
 * 
 * const versions = await client.getVersions('@myorg/package');
 * ```
 */

export * from './registry-client.js';
export * from './npm-registry-client.js';
export * from './npm-config-reader.js';
