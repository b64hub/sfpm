import { ComponentSet } from "@salesforce/source-deploy-retrieve";
import { ProjectDefinition, PackageDefinition } from "../project/types.js";
import { PackageType, SfpmPackageContent, SfpmPackageMetadata } from "../types/package.js";
import * as _ from "lodash";
import path from "path";


export default class SfpmPackage {

    private _metadata: SfpmPackageMetadata;

    // Runtime-only properties (Excluded from JSON)
    public projectDirectory: string;
    public stagingDirectory: string = '';
    public mdapiDir?: string = path.join(this.stagingDirectory, 'metadata');

    public projectDefinition?: ProjectDefinition;
    public packageDefinition?: PackageDefinition;

    private orgDefinitionPath?: string = path.join('config', 'project-scratch-def.json');

    private _componentSet?: ComponentSet;

    constructor(packageName: string, projectDirectory: string, metadata?: Partial<SfpmPackageMetadata>) {
        this.projectDirectory = projectDirectory;
        this._metadata = {
            identity: {
                packageName: packageName,
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

    get packageDirectory(): string | undefined {
        if (!this.packageDefinition?.path) {
            return undefined;
        }

        return path.join(this.stagingDirectory, this.packageDefinition?.path);
    }

    public getComponentSet(): ComponentSet {
        if (!this.packageDirectory) {
            throw new Error('Package must be staged for build and have a defined path');
        }

        if (!this._componentSet) {
            this._componentSet = ComponentSet.fromSource(path.join(this.stagingDirectory, this.packageDirectory));
        }

        return this._componentSet;
    }

    /**
     * Returns the logical manifest of the package as a JSON-compatible object.
     */
    public async getManifestObject() {
        return await this.getComponentSet().getObject();
    }

    public setApexClassification(classes: string[], tests: string[]) {
        const componentSet = this.getComponentSet();

        const filterExistingApex = (names: string[]) => 
            names.filter(name => componentSet.has({ fullName: name, type: 'ApexClass' }));

        this._metadata.content.apex = {
            classes: filterExistingApex(classes),
            tests: filterExistingApex(tests)
        };
    }

    get apexClasses(): string[] {

        if (this._metadata.content?.apex?.classes?.length) {
            return this._metadata.content.apex.classes;
        }

        // fallback: Query the ComponentSet for everything identified as Apex
        return this.getComponentSet()
            .getSourceComponents().toArray()
            .filter(c => c.type.id === 'apexclass')
            .map(c => c.fullName);
    }

    get hasApex(): boolean {
        const apexTypes = ['apexclass', 'apextrigger'];
        return this.getComponentSet()
            .getSourceComponents().toArray()
            .some(c => apexTypes.includes(c.type.id));
    }

    get testClasses(): string[] {
        return this._metadata.content?.apex?.tests || [];
    }

    get triggers(): string[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'apextrigger')
            .map(c => c.fullName);
    }

    get testSuites(): string[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'testsuite')
            .map(c => c.fullName);
    }

    get hasProfiles(): boolean {
        return this.getComponentSet().getSourceComponents().toArray()
            .some(c => c.type.id === 'profile');
    }

    get hasPermissionSetGroups(): boolean {
        return this.getComponentSet().getSourceComponents().toArray()
            .some(c => c.type.id === 'permissionsetgroup');
    }

    get includesProfileSupportedTypes(): boolean {
        const profileSupportedMetadataTypes = [
            'apexclass',
            'customapplication',
            'customobject',
            'customfield',
            'layout',
            'apexpage',
            'customtab',
            'recordtype',
            'systempermissions',
        ];

        return this.getComponentSet().getSourceComponents().toArray()
            .some(c => profileSupportedMetadataTypes.includes(c.type.id));
    }

    get hasDestructiveChanges(): boolean {
        return !!this._metadata.content?.destructiveChangesPath;
    }

    get isTriggerAllTests(): boolean {
        if (this._metadata.validation?.isTriggerAllTests) {
            return true;
        }

        const apex = this._metadata.content?.apex;
        const hasTestClasses = (apex?.tests?.length || 0) > 0;

        return this.hasApex && !hasTestClasses;
    }

    /**
     * @description: Resolves the content of the package from the component set.
     * @returns: A promise that resolves to the content of the package.
     */
    private async resolveContentMetadata(): Promise<SfpmPackageContent> {
        const cs = this.getComponentSet();
        const components = cs.getSourceComponents();

        return {
            metadataCount: components.toArray().length,
            payload: await cs.getObject(),
            apex: {
                classes: this.apexClasses,
                tests: this.testClasses
            },
            triggers: this.triggers,
            testSuites: this.testSuites,
        };
    }

    /**
     * @description: Converts the package to a package metadata object.
     * @returns: A promise that resolves to the package metadata object.
     */
    public async toPackageMetadata(): Promise<SfpmPackageMetadata> {
        const content = await this.resolveContentMetadata();

        return _.merge({}, this._metadata, {
            content,
            identity: {
                packageName: this.name || content.payload?.Package?.fullName
            }
        });
    }

    // Override toJSON to ensure serialization is always reconciled
    public async toJSON() {
        return await this.toPackageMetadata();
    }
}