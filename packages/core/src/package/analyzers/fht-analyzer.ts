import { ComponentSet } from "@salesforce/source-deploy-retrieve";
import { PackageAnalyzer, RegisterAnalyzer } from "./analyzer-registry.js";
import { PackageType, SfpmPackageMetadata, SfpmPackageOrchestration } from "../../types/package.js";
import SfpmPackage from "../sfpm-package.js";
import * as path from 'path';
import * as fs from 'fs-extra';
import * as yaml from 'js-yaml';

import { Logger } from "../../types/logger.js";

@RegisterAnalyzer()
export default class FHTAnalyzer implements PackageAnalyzer {
    private logger?: Logger;

    constructor(logger?: Logger) {
        this.logger = logger;
    }

    public isEnabled(sfpmPackage: SfpmPackage): boolean {
        return (sfpmPackage.type !== PackageType.Data);
    }

    public async analyze(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageOrchestration>> {
        if (!sfpmPackage.packageDirectory) {
            return {};
        }

        let fhtFields: string[] = [];

        try {
            const fhtConfig = await this.readYaml(path.join(
                sfpmPackage.packageDirectory,
                'postDeploy', 'history-tracking.yml'
            ));

            fhtFields = await this.filterFields(sfpmPackage.getComponentSet(), fhtConfig);

        } catch (error) {
            this.logger?.trace(`Unable to process Field History Tracking due to ${error}`);
        }

        return { fhtFields };
    }

    private async readYaml(path: string): Promise<Map<string, string[]>> {
        if (!(await fs.exists(path))) {
            throw new Error(`No file found at ${path}`);
        }
        return yaml.load((await fs.readFile(path, 'utf-8'))) as Map<string, string[]>;
    }

    private async filterFields(
        componentSet: ComponentSet,
        fhtConfig: Map<string, string[]>,
    ): Promise<string[]> {

        const fhtFields: string[] = [];
        
        let customFields = componentSet.getSourceComponents().toArray().filter((component) => {
            return component.type.id === 'customfield';
        });

        for (const customField of customFields) {

            let customFieldXml = customField.parseXmlSync().CustomField as any;
            if (!customFieldXml || !customFieldXml['trackHistory'] || customFieldXml['trackHistory'] == 'false') {
                continue;
            }

            let customObjectName = customField.parent?.fullName;
            if (!customObjectName || !fhtConfig.has(customObjectName)) {
                continue;
            }

            let fieldNames = fhtConfig.get(customObjectName);
            if (!fieldNames || !fieldNames.includes(customField.name)) {
                continue;
            }

            fhtFields.push(customField.fullName);
            this.logger?.trace(`Found field ${customField.name} in object ${customObjectName}`);
        }

        return fhtFields;
    }
}