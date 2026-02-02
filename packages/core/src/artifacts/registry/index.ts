/**
 * Registry client interfaces and implementations for interacting with package registries.
 * 
 * @example
 * ```typescript
 * import { NpmRegistryClient, RegistryClient } from './registry';
 * 
 * const client: RegistryClient = new NpmRegistryClient({
 *     registryUrl: 'https://registry.npmjs.org',
 * });
 * 
 * const versions = await client.getVersions('my-package');
 * ```
 */

export * from './registry-client.js';
export * from './npm-registry-client.js';
