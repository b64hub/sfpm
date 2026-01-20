import { ComponentSet, MetadataConverter, ConvertResult } from '@salesforce/source-deploy-retrieve';
import fs from 'fs-extra';
import { Logger } from '../types/logger.js';

export default class MDAPIConverter {
    public constructor(
        private apiVersion?: string,
        private logger?: Logger
    ) { }

    public async convert(sourceDirectory: string, targetDirectory: string): Promise<ConvertResult> {
        if (!(await fs.pathExists(targetDirectory))) {
            await fs.mkdir(targetDirectory, { recursive: true });
        }

        let componentSet = ComponentSet.fromSource({
            fsPaths: [sourceDirectory],
        });

        if (this.apiVersion) componentSet.sourceApiVersion = this.apiVersion;

        const converter = new MetadataConverter();
        let convertResult = await converter.convert(componentSet, 'metadata', {
            type: 'directory',
            outputDirectory: targetDirectory,
        });

        return convertResult;
    }
}
