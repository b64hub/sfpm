import type {Logger} from '@b64/sfpm-core';
import type {Connection} from '@salesforce/core';

import type {PermSetAssignmentResult} from './types.js';

/**
 * Shape returned by a SOQL query for existing permission set assignments.
 */
interface PermSetAssignmentRecord {
  PermissionSet: {Name: string};
}

/**
 * Assigns permission sets to the running user in a Salesforce org.
 *
 * The assigner queries existing assignments first and skips any permission
 * sets that are already assigned — this makes the operation idempotent.
 *
 * Uses the REST API via the jsforce {@link Connection} rather than
 * shelling out to the CLI, so no `sf` binary is required at runtime.
 */
export class PermissionSetAssigner {
  constructor(
    private readonly connection: Connection,
    private readonly logger?: Logger,
  ) {}

  /**
   * Assign a list of permission sets to the connection's authenticated user.
   *
   * @param permSetNames - API names of the permission sets to assign.
   * @returns Categorised results: assigned, skipped (already assigned), failed.
   */
  async assign(permSetNames: string[]): Promise<PermSetAssignmentResult> {
    const result: PermSetAssignmentResult = {assigned: [], failed: [], skipped: []};
    if (permSetNames.length === 0) return result;

    const username = this.connection.getUsername();
    if (!username) {
      throw new Error('PermissionSet: unable to determine target org username');
    }

    // ── Resolve the user's record Id ────────────────────────────
    const userId = await this.resolveUserId(username);

    // ── Fetch existing assignments ──────────────────────────────
    const alreadyAssigned = await this.fetchExistingAssignments(userId);

    // ── Process each requested permission set ───────────────────
    for (const name of permSetNames) {
      if (alreadyAssigned.has(name)) {
        this.logger?.debug(`PermissionSet: '${name}' already assigned to ${username}, skipping`);
        result.skipped.push(name);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop -- sequential to avoid hammering the API
      const entry = await this.assignSingle(name, userId, username);
      if (entry.success) {
        result.assigned.push(name);
      } else {
        result.failed.push({message: entry.message, name});
      }
    }

    return result;
  }

  /**
   * Assign a single permission set to a user.
   */
  private async assignSingle(
    permSetName: string,
    userId: string,
    username: string,
  ): Promise<{message: string; success: boolean}> {
    // Look up the PermissionSet Id
    const psQuery = await this.connection.query<{Id: string; Name: string}>(`SELECT Id, Name FROM PermissionSet WHERE Name = '${escapeSOQL(permSetName)}'`);

    if (psQuery.records.length === 0) {
      const msg = `permission set '${permSetName}' not found in org`;
      this.logger?.warn(`PermissionSet: ${msg}`);
      return {message: msg, success: false};
    }

    // Create the assignment
    const createResult = await this.connection.sobject('PermissionSetAssignment').create({
      AssigneeId: userId,
      PermissionSetId: psQuery.records[0].Id,
    });

    if (createResult.success) {
      this.logger?.debug(`PermissionSet: assigned '${permSetName}' to ${username}`);
      return {message: '', success: true};
    }

    const errors = 'errors' in createResult
      ? (createResult.errors as Array<{message: string}>).map(e => e.message).join(', ')
      : 'Unknown error';

    this.logger?.warn(`PermissionSet: failed to assign '${permSetName}': ${errors}`);
    return {message: errors, success: false};
  }

  /**
   * Fetch the set of permission set API names already assigned to a user.
   */
  private async fetchExistingAssignments(userId: string): Promise<Set<string>> {
    const queryResult = await this.connection.query<PermSetAssignmentRecord>(`SELECT PermissionSet.Name FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`);
    return new Set(queryResult.records.map(r => r.PermissionSet.Name));
  }

  /**
   * Query the User Id for the given username.
   */
  private async resolveUserId(username: string): Promise<string> {
    const record = await this.connection.singleRecordQuery<{Id: string}>(`SELECT Id FROM User WHERE Username = '${escapeSOQL(username)}'`);
    return record.Id;
  }
}

/**
 * Escape a string for safe inclusion in a SOQL single-quoted literal.
 */
function escapeSOQL(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", String.raw`\'`);
}
