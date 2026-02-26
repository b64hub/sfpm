import * as core from '@actions/core';

import {validatePr} from './validate-pr.js';

// ============================================================================
// Action Entry Point
// ============================================================================

/**
 * Main entry point for the `sfpm-actions/validate-pr` GitHub Action.
 *
 * Reads inputs from the workflow YAML, runs the PR validation pipeline,
 * and sets outputs for downstream steps.
 */
async function run(): Promise<void> {
    try {
        const devhubUsername = core.getInput('devhub-username', {required: true});
        const poolTag = core.getInput('pool-tag', {required: true});
        const cacheTtlHours = Number.parseInt(core.getInput('cache-ttl-hours') || '4', 10);
        const projectDir = core.getInput('project-dir') || undefined;
        const packagesInput = core.getInput('packages') || '';
        const packages = packagesInput
            ? packagesInput.split(',').map(p => p.trim()).filter(Boolean)
            : undefined;

        const result = await validatePr({
            cacheTtlHours,
            devhubUsername,
            packages,
            poolTag,
            projectDir,
        });

        if (!result.success) {
            // core.setFailed is already called inside validatePr
            process.exitCode = 1;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.setFailed(message);
        process.exitCode = 1;
    }
}

run();
