import { PackageAnalyzer, RegisterAnalyzer } from "./analyzer-registry.js";
import { PackageType, SfpmPackageContent } from "../../types/package.js";
import SfpmPackage, { SfpmMetadataPackage } from "../sfpm-package.js";
import * as path from 'path';
import * as fs from 'fs-extra';
import * as yaml from 'js-yaml';

import { Logger } from "../../types/logger.js";
import { MetadataComponent } from "@salesforce/source-deploy-retrieve";

const FT_FILE_NAME = 'feed-tracking.yml';

@RegisterAnalyzer()
export default class FTAnalyzer implements PackageAnalyzer {
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
            const ftConfig = await this.readYaml(path.join(
                sfpmPackage.packageDirectory,
                'postDeploy', FT_FILE_NAME
            ));

            const enabledFields = await this.ftEnabledFields(sfpmPackage);
            const ftFields = enabledFields.filter(f => ftConfig.includes(f.fullName));

            sfpmPackage.setFtFields(ftFields.map(f => f.fullName));

        } catch (error) {
            this.logger?.trace(`Unable to process Feed Tracking due to ${error}`);
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

    private async ftEnabledFields(sfpmPackage: SfpmMetadataPackage): Promise<MetadataComponent[]> {
        const ftFields: MetadataComponent[] = [];

        for (const customField of sfpmPackage.customFields) {
            const customFieldXml = (await customField.parseXml() as any).CustomField;
            if (customFieldXml.trackFeedHistory) {
                ftFields.push(customField);
            }
        }

        return ftFields;
    }
}