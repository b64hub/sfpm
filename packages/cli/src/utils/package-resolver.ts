import {type ProjectDefinitionProvider, resolvePackageName} from '@b64hub/sfpm-core';
import {select} from '@inquirer/prompts';

/**
 * Resolve user-supplied package names to fully scoped names.
 *
 * Users can type short unscoped names (e.g. `my-package`) — this function
 * resolves them to the canonical scoped name (e.g. `@b64/my-package`)
 * using the project definition as the source of truth.
 *
 * When an unscoped name matches multiple packages across scopes,
 * the user is prompted to disambiguate (interactive mode) or an
 * error is thrown (JSON/CI mode).
 *
 * @param inputs  - Package names from CLI args (scoped or unscoped)
 * @param provider - Project definition provider for package lookups
 * @param options  - Control prompt behavior
 * @returns Fully scoped package names
 */
export async function resolvePackageInputs(
  inputs: string[],
  provider: ProjectDefinitionProvider,
  options?: {json?: boolean},
): Promise<string[]> {
  const allNames = provider.getAllPackageNames();
  const resolved: string[] = [];

  for (const input of inputs) {
    const result = resolvePackageName(input, allNames);

    if (typeof result === 'string') {
      resolved.push(result);
      continue;
    }

    // Ambiguous — multiple packages match the unscoped name
    if (options?.json) {
      throw new Error(`Ambiguous package name "${input}" matches multiple packages:\n`
        + result.map(n => `  - ${n}`).join('\n')
        + '\nUse the fully scoped name to disambiguate.');
    }

    // Interactive mode — prompt the user to pick
    // eslint-disable-next-line no-await-in-loop
    const choice = await select({
      choices: result.map(name => ({value: name})),
      message: `"${input}" matches multiple packages — which one?`,
    });

    resolved.push(choice);
  }

  return resolved;
}
