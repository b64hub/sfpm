import {StateAggregator} from '@salesforce/core';

/** 
 * Set a local alias for a username.
 *
 * @param username The username to alias.
 * @param alias The alias to set for the username.
 */
export default async function setAlias(username: string, alias: string): Promise<void> {
  const stateAggregator = await StateAggregator.getInstance();
  await stateAggregator.aliases.setAndSave(alias, username);
}