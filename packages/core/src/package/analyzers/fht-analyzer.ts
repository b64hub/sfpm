import { PackageAnalyzer, RegisterAnalyzer } from "./analyzer-registry.js";
import { PackageType, SfpmPackageContent } from "../../types/package.js";
import { SfpmMetadataPackage } from "../sfpm-package.js";
import path from 'path';
import fs from 'fs-extra';
import yaml from 'js-yaml';

import { Logger } from "../../types/logger.js";
import { MetadataComponent } from "@salesforce/source-deploy-retrieve";


const FHT_FILE_NAME = 'history-tracking.yml';

@RegisterAnalyzer()
export default class FHTAnalyzer implements PackageAnalyzer {
    private logger?: Logger;

    constructor(logger?: Logger) {
        this.logger = logger;
    }

    public isEnabled(sfpmPackage: SfpmMetadataPackage): boolean {
        return (sfpmPackage.type !== PackageType.Data);
    }

    public async analyze(sfpmPackage: SfpmMetadataPackage): Promise<Partial<SfpmPackageContent>> {
        if (!sfpmPackage.packageDirectory) {
            return {};
        }

        try {
            const fhtConfig = await this.readYaml(path.join(
                sfpmPackage.packageDirectory,
                'postDeploy', FHT_FILE_NAME
            ));

            const enabledFields = await this.fhtEnabledFields(sfpmPackage);
            const fhtFields = enabledFields.filter(f => fhtConfig.includes(f.fullName));

            return {
                fields: {
                    fht: fhtFields.map(f => f.fullName)
                }
            } as Partial<SfpmPackageContent>;

        } catch (error) {
            this.logger?.trace(`Unable to process Field History Tracking due to ${error}`);
        }

        return {};
    }

    private async readYaml(path: string): Promise<string[]> {
        if (!(await fs.exists(path))) {
            throw new Error(`No file found at ${path}`);
        }
        const config = yaml.load((await fs.readFile(path, 'utf-8'))) as { [key: string]: string[] };
        return Object.values(config).flat();
    }

    private async fhtEnabledFields(sfpmPackage: SfpmMetadataPackage): Promise<MetadataComponent[]> {
        const fhtFields: MetadataComponent[] = [];

        for (const customField of sfpmPackage.customFields) {
            const customFieldXml = (await customField.parseXml() as any).CustomField;
            if (customFieldXml.trackHistory) {
                fhtFields.push(customField);
            }
        }

        return fhtFields;
    }
}