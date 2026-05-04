/**
 * Registry client interfaces and implementations for interacting with package registries.
 *
 * @example
 * ```typescript
 * import { PnpmRegistryClient, RegistryClient } from './registry';
 *
 * const client: RegistryClient = new PnpmRegistryClient({
 *     projectDir: '/path/to/project',
 * });
 *
 * const versions = await client.getVersions('@myorg/package');
 * ```
 */

export * from './registry-client.js';
export * from './pnpm-registry-client.js';
