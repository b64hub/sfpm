import {OrgTypes} from '@salesforce/core';
import {describe, expect, it} from 'vitest';

import {buildPoolConfig, type ProvisionPoolOptions} from '../src/provision-pool.js';

const baseOptions: ProvisionPoolOptions = {
    devhubUsername: 'hub',
    tag: 'dev',
};

describe('buildPoolConfig', () => {
    it('falls back to sfpm.config.ts pool config when no workflow inputs given', () => {
        const config = buildPoolConfig(baseOptions, OrgTypes.Scratch, '/proj', {
            definitionFile: 'config/project-scratch-def.json',
            expiryDays: 14,
            sizing: {max: 20},
            type: OrgTypes.Scratch,
        });

        expect(config.definitionFile).toBe('/proj/config/project-scratch-def.json');
        expect(config.expiryDays).toBe(14);
        expect(config.sizing.max).toBe(20);
    });

    it('workflow inputs take precedence over sfpm.config.ts', () => {
        const config = buildPoolConfig(
            {...baseOptions, definitionFile: 'config/override-def.json', expiryDays: 3, maxAllocation: 5},
            OrgTypes.Scratch,
            '/proj',
            {definitionFile: 'config/project-scratch-def.json', expiryDays: 14, sizing: {max: 20}, type: OrgTypes.Scratch},
        );

        expect(config.definitionFile).toBe('/proj/config/override-def.json');
        expect(config.expiryDays).toBe(3);
        expect(config.sizing.max).toBe(5);
    });

    it('throws when no definitionFile is available from either source', () => {
        expect(() => buildPoolConfig(baseOptions, OrgTypes.Scratch, '/proj', undefined)).toThrow(/definition-file is required/);
    });

    it('throws when no max is available from either source', () => {
        const config = {definitionFile: 'config/project-scratch-def.json', sizing: {}, type: OrgTypes.Scratch} as never;
        expect(() => buildPoolConfig(baseOptions, OrgTypes.Scratch, '/proj', config)).toThrow(/max-allocation is required/);
    });
});
