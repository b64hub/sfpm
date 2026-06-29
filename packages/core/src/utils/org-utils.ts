import {Org, StateAggregator} from '@salesforce/core';

/**
 * Classify an org type
 * @param org - the org to resolve
 * @returns - Type of org
 */
export async function resolveOrgType(org: Org): Promise<'devhub' | 'sandbox' | 'scratch' | undefined> {
  if (await org.isSandbox()) return 'sandbox';
  if (org.isScratch()) return 'scratch';
  if (org.isDevHubOrg()) return 'devhub';
  return undefined;
}

/**
 * Convert an alias to a username
 * @param alias - The alias to convert
 * @returns The username or undefined if not found
 */
export async function aliasToUsername(alias: string): Promise<string | undefined> {
  const stateAggregator = await StateAggregator.getInstance();
  await stateAggregator.orgs.readAll();
  return stateAggregator.aliases.resolveUsername(alias);
}

/**
 * Convert a username to an alias
 * @param username - The username to convert
 * @returns The alias or undefined if not found
 */
export async function usernameToAlias(username: string): Promise<string | undefined> {
  const stateAggregator = await StateAggregator.getInstance();
  await stateAggregator.orgs.readAll();
  return stateAggregator.aliases.resolveAlias(username);
}
