import {MetadataComponent} from '@salesforce/source-deploy-retrieve';

import type {SfpmMetadataPackage} from '../sfpm-package.js';

import {Logger} from '../../types/logger.js';
import {PackageType, SfpmPackageContent} from '../../types/package.js';
import {PackageAnalyzer} from './analyzer-registry.js';

const PICKLIST_TYPES = new Set(['MultiselectPicklist', 'Picklist']);

export default class PicklistAnalyzer implements PackageAnalyzer {
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  public async analyze(sfpmPackage: SfpmMetadataPackage): Promise<Partial<SfpmPackageContent>> {
    if (!sfpmPackage.customFields) {
      return {};
    }

    const picklists: MetadataComponent[] = [];

    try {
      for (const field of sfpmPackage.customFields) {
        // eslint-disable-next-line no-await-in-loop
        const customField = (await field.parseXml()).CustomField as any;

        if (customField && PICKLIST_TYPES.has(customField.type)) {
          picklists.push(field);
        }
      }
    } catch (error) {
      this.logger?.trace(`Unable to process Picklist update due to ${error}`);
    }

    sfpmPackage.setPicklists(picklists.map(p => p.fullName));

    return {};
  }

  public isEnabled(sfpmPackage: SfpmMetadataPackage): boolean {
    return sfpmPackage.type !== PackageType.Data;
  }
}
