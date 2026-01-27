import { ComponentSet, MetadataComponent, registry } from '@salesforce/source-deploy-retrieve';
import SfpmPackage, { SfpmMetadataPackage } from '../sfpm-package.js';
import { PackageType, SfpmPackageContent, SfpmPackageMetadata } from '../../types/package.js';
import { PackageAnalyzer } from './analyzer-registry.js';

import { Logger } from '../../types/logger.js';

const PICKLIST_TYPES = ['Picklist', 'MultiselectPicklist'];

export default class PicklistAnalyzer implements PackageAnalyzer {
    private logger?: Logger;

    constructor(logger?: Logger) {
        this.logger = logger;
    }

    public isEnabled(sfpmPackage: SfpmMetadataPackage): boolean {
        return sfpmPackage.type != PackageType.Data;
    }
          
    public async analyze(sfpmPackage: SfpmMetadataPackage): Promise<Partial<SfpmPackageContent>> {

        if (!sfpmPackage.customFields) {
            return {};
        }

        const picklists: MetadataComponent[] = [];
        
        try {
            
            for (const field of sfpmPackage.customFields) {
                let customField = (await field.parseXml()).CustomField as any;

                if (customField && PICKLIST_TYPES.includes(customField.type)) {
                    picklists.push(field);
                }
            }
        } catch (error) {
            this.logger?.trace(`Unable to process Picklist update due to ${error}`);
        }

        sfpmPackage.setPicklists(picklists.map(p => p.fullName));

        return {};
    }
}
