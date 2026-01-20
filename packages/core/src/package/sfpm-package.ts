import { ProjectDefinition, PackageDefinition } from "../project/types.js";
import { PackageType, SfpmPackageMetadata } from "../types/package.js";
import * as _ from "lodash";


export default class SfpmPackage {
    // The Data
    private _metadata: SfpmPackageMetadata;

    // Runtime-only properties (Excluded from JSON)
    public projectDirectory: string;
    public workingDirectory: string = '';
    public mdapiDir?: string;
    public resolvedPackageDirectory?: string;
    public projectDefinition?: ProjectDefinition;
    public packageDefinition?: PackageDefinition;
    public orgDefinitionFilePath?: string = 'config/project-scratch-def.json';
    public changelogFilePath?: string;

    constructor(packageName: string, projectDirectory: string, metadata?: Partial<SfpmPackageMetadata>) {
        this.projectDirectory = projectDirectory;
        this._metadata = {
            identity: {
                packageName: '',
                packageType: '',
                ...metadata?.identity
            },
            source: { ...metadata?.source },
            content: { ...metadata?.content },
            validation: { ...metadata?.validation },
            orchestration: { ...metadata?.orchestration },
            ..._.omit(metadata, ['identity', 'source', 'content', 'validation', 'orchestration'])
        } as SfpmPackageMetadata;
    }

    // Accessors to maintain compatibility with existing code
    get metadata() { return this._metadata; }

    get name() { return this._metadata.identity.packageName; }
    set name(val: string) { this._metadata.identity.packageName = val; }

    get packageName() { return this._metadata.identity.packageName; }
    set packageName(val: string) { this._metadata.identity.packageName = val; }

    get version() { return this._metadata.identity.versionNumber; }
    set version(val: string | undefined) { this._metadata.identity.versionNumber = val; }

    get type() { return this._metadata.identity.packageType; }
    set type(val: Omit<PackageType, 'managed'>) { this._metadata.identity.packageType = val; }

    get sourceVersion() { return this._metadata.source.sourceVersion; }
    set sourceVersion(val: string | undefined) { this._metadata.source.sourceVersion = val; }

    get tag() { return this._metadata.source.tag; }
    set tag(val: string | undefined) { this._metadata.source.tag = val; }

    // Inferred Getters
    get hasApex(): boolean {
        return (this.metadata.content?.apex?.classes?.length || 0) > 0 || this.triggers.length > 0;
    }

    get triggers(): string[] {
        const payload = this._metadata.content?.payload;
        if (!payload || !payload.Package || !payload.Package.types) {
            return this._metadata.content?.apex?.triggers || [];
        }

        const types = _.castArray(payload.Package.types);
        const triggerType = types.find((type: any) => type.name === 'ApexTrigger');
        return triggerType ? _.castArray(triggerType.members) : (this._metadata.content?.apex?.triggers || []);
    }

    get hasProfiles(): boolean {
        const payload = this._metadata.content?.payload;
        if (!payload || !payload.Package || !payload.Package.types) {
            return false;
        }

        const types = _.castArray(payload.Package.types);
        return types.some((type: any) => type.name === 'Profile');
    }

    get hasPermissionSetGroups(): boolean {
        const payload = this._metadata.content?.payload;
        if (!payload || !payload.Package || !payload.Package.types) {
            return false;
        }

        const types = _.castArray(payload.Package.types);
        return types.some((type: any) => type.name === 'PermissionSetGroup');
    }

    get isPayloadContainTypesSupportedByProfiles(): boolean {
        const payload = this._metadata.content?.payload;
        if (!payload || !payload.Package || !payload.Package.types) {
            return false;
        }

        const profileSupportedMetadataTypes = [
            'ApexClass',
            'CustomApplication',
            'CustomObject',
            'CustomField',
            'Layout',
            'ApexPage',
            'CustomTab',
            'RecordType',
            'SystemPermissions',
        ];

        const types = _.castArray(payload.Package.types);
        return types.some((t: any) => profileSupportedMetadataTypes.includes(t.name));
    }

    get hasDestructiveChanges(): boolean {
        return !!this._metadata.content?.destructiveChangesPath;
    }

    get shouldTriggerAllTests(): boolean {
        if (this._metadata.validation?.isTriggerAllTests) {
            return true;
        }

        const apex = this._metadata.content?.apex;
        const hasTestClasses = (apex?.testClasses?.length || 0) > 0;

        return this.hasApex && !hasTestClasses;
    }

    /**
     * Replaces the complex toJSON logic. 
     * Only returns the metadata interface.
     */
    public toPackageMetadata(): SfpmPackageMetadata {
        return _.cloneDeep(this._metadata);
    }

    public toJSON(): SfpmPackageMetadata {
        return this.toPackageMetadata();
    }
}