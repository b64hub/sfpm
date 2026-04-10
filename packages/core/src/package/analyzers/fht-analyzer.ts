import type {SfpmMetadataPackage} from '../sfpm-package.js';

import {Logger} from '../../types/logger.js';
import {PackageType, SfpmPackageContent} from '../../types/package.js';
import {PackageAnalyzer, RegisterAnalyzer} from './analyzer-registry.js';

// eslint-disable-next-line new-cap
@RegisterAnalyzer()
export default class FHTAnalyzer implements PackageAnalyzer {
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  public async analyze(sfpmPackage: SfpmMetadataPackage): Promise<Partial<SfpmPackageContent>> {
    if (!sfpmPackage.customFields?.length) {
      return {};
    }

    try {
      const fhtFieldNames: string[] = [];

      for (const customField of sfpmPackage.customFields) {
        // eslint-disable-next-line no-await-in-loop
        const customFieldXml = (await customField.parseXml() as any).CustomField;
        if (customFieldXml?.trackHistory && customFieldXml.trackHistory === 'true') {
          fhtFieldNames.push(customField.fullName);
        }
      }

      sfpmPackage.setFhtFields(fhtFieldNames);
    } catch (error) {
      this.logger?.trace(`Unable to process Field History Tracking due to ${error}`);
    }

    return {};
  }

  public isEnabled(sfpmPackage: SfpmMetadataPackage): boolean {
    return (sfpmPackage.type !== PackageType.Data);
  }
}
