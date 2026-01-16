import { StateAggregator } from '@salesforce/core';

/**
 * Convert an alias to a username
 * @param alias - The alias to convert
 * @returns The username or undefined if not found
 */
export async function convertAliasToUsername(alias: string): Promise<string | undefined> {
    const stateAggregator = await StateAggregator.getInstance();
    await stateAggregator.orgs.readAll();
    return await stateAggregator.aliases.resolveUsername(alias);
}

/**
 * Convert a username to an alias
 * @param username - The username to convert
 * @returns The alias or undefined if not found
 */
export async function convertUsernameToAlias(username: string): Promise<string | undefined> {
    const stateAggregator = await StateAggregator.getInstance();
    await stateAggregator.orgs.readAll();
    return await stateAggregator.aliases.resolveAlias(username);
}
