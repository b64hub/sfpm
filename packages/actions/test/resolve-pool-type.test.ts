import {OrgTypes} from '@salesforce/core';
import {describe, expect, it} from 'vitest';

import {resolvePoolType} from '../src/validate-pr.js';

describe('resolvePoolType', () => {
    it('falls back to sfpm.config.ts orgs.pools[tag].type', () => {
        const sfpmConfig = {orgs: {ci: {type: OrgTypes.Sandbox}}};
        expect(resolvePoolType(sfpmConfig, 'ci', undefined)).toBe(OrgTypes.Sandbox);
    });

    it('explicit poolType input overrides sfpm.config.ts', () => {
        const sfpmConfig = {orgs: {ci: {type: OrgTypes.Sandbox}}};
        expect(resolvePoolType(sfpmConfig, 'ci', OrgTypes.Scratch)).toBe(OrgTypes.Scratch);
    });

    it('defaults to scratch when no config or input is available', () => {
        expect(resolvePoolType({}, 'unknown-tag', undefined)).toBe(OrgTypes.Scratch);
    });
});
