import { ProjectDefinition } from "../project/types.js";
import { PackageType } from "../types/package.js";
import { SfpPackageMetadata } from "../types/package.js";
import * as _ from "lodash";


export default class SfpmPackage {
    // The Data
    private _metadata: SfpPackageMetadata;

    // Runtime-only properties (Excluded from JSON)
    public projectDirectory: string;
    public workingDirectory: string = '';
    public mdapiDir?: string;
    public resolvedPackageDirectory?: string;
    public projectDefinition?: ProjectDefinition;
    public packageDefinition?: PackageDefinition;
    public orgDefinitionFilePath?: string;
    public changelogFilePath?: string;

    constructor(projectDirectory: string, metadata?: Partial<SfpPackageMetadata>) {
        this.projectDirectory = projectDirectory;
        this._metadata = {
            packageName: '',
            packageType: PackageType.Source,
            ...metadata
        };
    }

    // Accessors to maintain compatibility with existing code
    get metadata() { return this._metadata; }
    
    get packageName() { return this._metadata.packageName; }
    set packageName(val: string) { this._metadata.packageName = val; }

    /**
     * Replaces the complex toJSON logic. 
     * Only returns the metadata interface.
     */
    public toPackageMetadata(): SfpPackageMetadata {
        return _.cloneDeep(this._metadata);
    }

    // You can still implement toJSON for JSON.stringify()
    public toJSON(): SfpPackageMetadata {
        return this.toPackageMetadata();
    }
}