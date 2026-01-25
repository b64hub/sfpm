import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import { Logger } from "../../../types/logger.js";
import ProjectConfig from "../../../project/project-config.js";
import MDAPIConverter from "../../../utils/mdapi-converter.js";
import { ConvertResult } from "@salesforce/source-deploy-retrieve";
import { SfpmPackageManifest } from "../../../types/package.js";
import path from 'path';
// @ts-ignore
import * as _ from 'lodash';

/**
 * @description Transforms the source code in the staging directory into MDAPI format.
 * The results are stored in a `metadataPackage` sub-directory.
 */
export class MDAPIConversionStep implements AssemblyStep {
    constructor(
        private packageName: string,
        private projectConfig: ProjectConfig,
        private logger?: Logger
    ) { }

    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        const packageDefinition = this.projectConfig.getPackageDefinition(this.packageName);
        const sourceDir = path.join(output.stagingDirectory, packageDefinition.path);
        const mdapiDir = path.join(output.stagingDirectory, 'metadataPackage');

        this.logger?.debug(`[MDAPIConversionStep] Converting ${sourceDir} to MDAPI in ${mdapiDir}`);

        try {
            const converter = new MDAPIConverter(this.projectConfig.sourceApiVersion, this.logger);
            const result = await converter.convert(sourceDir, mdapiDir);

            if (!result.packagePath) {
                throw new Error('[MDAPIConversionStep] MDAPI Conversion result is missing packagePath');
            }

            // Analyze manifest
            const manifestJson = this.getManifestFromConvertResult(result);
            if (this.projectConfig.sourceApiVersion) {
                manifestJson.Package.version = this.projectConfig.sourceApiVersion;
            }

            output.mdapiConversion = {
                payload: manifestJson,
                result: result,
            };
        } catch (error: any) {
            throw new Error(`[MDAPIConversionStep] MDAPI Conversion failed: ${error.message}`);
        }
    }

    private getManifestFromConvertResult(result: ConvertResult): SfpmPackageManifest {
        const converted = result.converted || [];

        const typesMap = new Map<string, string[]>();
        for (const component of converted) {
            const typeName = component.type.name;
            const members = typesMap.get(typeName) || [];
            members.push(component.fullName);
            typesMap.set(typeName, members);
        }

        return {
            Package: {
                xmlns: 'http://soap.sforce.com/2006/04/metadata',
                types: Array.from(typesMap.entries()).map(([name, members]) => ({
                    name,
                    members: _.uniq(members),
                })),
                version: '',
            }
        };
    }
}
