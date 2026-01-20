import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import MDAPIConverter from "../../../utils/mdapi-converter.js";
import path from 'path';

/**
 * @description Transforms the source code in the staging directory into MDAPI format.
 * The results are stored in a `metadataPackage` sub-directory.
 */
export class MDAPIConversionStep implements AssemblyStep {
    /**
     * @description Executes the MDAPI conversion.
     * @param options Shared assembly configuration.
     * @param output Shared assembly output to be populated.
     */
    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        const packageDefinition = options.projectConfig.getPackageDefinition(options.packageName);
        const sourceDir = path.join(output.stagingDirectory, packageDefinition.path);
        const mdapiDir = path.join(output.stagingDirectory, 'metadataPackage');

        options.logger?.debug(`[MDAPIConversionStep] Converting ${sourceDir} to MDAPI in ${mdapiDir}`);

        try {
            const converter = new MDAPIConverter(options.projectConfig.sourceApiVersion, options.logger);
            const result = await converter.convert(sourceDir, mdapiDir);
            output.metadataApiResult = result;
        } catch (error: any) {
            throw new Error(`[MDAPIConversionStep] MDAPI Conversion failed: ${error.message}`);
        }
    }
}
