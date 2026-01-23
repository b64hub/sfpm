import { ComponentSet, SourceComponent } from "@salesforce/source-deploy-retrieve";
import { ProjectDefinition, PackageDefinition } from "../types/project.js";
import { PackageType, SfpmPackageContent, SfpmPackageMetadata, SfpmPackageOrchestration } from "../types/package.js";
import * as _ from "lodash";
import path from "path";

const TEST_COVERAGE_THRESHOLD = 75;
/**
 * Internal map used by SfpmPackage to validate component identities.
 */
const CONTENT_METADATA_TYPE: Record<string, string> = {
    'apex.classes': 'ApexClass',
    'apex.tests': 'ApexClass',
    'triggers': 'ApexTrigger',
    'fields.fht': 'CustomField',
    'fields.ft': 'CustomField',
    'fields.picklists': 'CustomField',
    'profiles': 'Profile',
    'permissionSetGroups': 'PermissionSetGroup',
    'permissionSets': 'PermissionSet',
    'standardValueSets': 'StandardValueSet',
};

const PROFILE_SUPPORTED_METADATA_TYPES = [
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


export default class SfpmPackage {

    private _metadata: SfpmPackageMetadata;

    public projectDirectory: string;
    public stagingDirectory: string | undefined;

    public projectDefinition?: ProjectDefinition;
    private _packageDefinition?: PackageDefinition;

    public orgDefinitionPath?: string = path.join('config', 'project-scratch-def.json');

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

    get metadata() { return this._metadata; }

    set id(val: string) { this._metadata.identity.packageId = val; }
    get id() { return this._metadata.identity.packageId; }

    get name() { return this._metadata.identity.packageName; }
    set name(val: string) { this._metadata.identity.packageName = val; }

    get packageName() { return this._metadata.identity.packageName; }
    set packageName(val: string) { this._metadata.identity.packageName = val; }

    get version() { return this._metadata.identity.versionNumber; }
    set version(val: string | undefined) { this._metadata.identity.versionNumber = val; }

    get type() { return this._metadata.identity.packageType; }
    set type(val: Omit<PackageType, 'managed'>) { this._metadata.identity.packageType = val; }

    get apiVersion() { return this._metadata.identity.apiVersion; }
    set apiVersion(val: string) { this._metadata.identity.apiVersion = val; }


    set packageDefinition(packageDefinition: PackageDefinition) {
        if (this._packageDefinition) {
            throw new Error('Package definition already set');
        }

        if (packageDefinition.package !== this.name) {
            throw new Error(`Package definition name ${packageDefinition.package} does not match package name ${this.name}`);
        }

        this._packageDefinition = packageDefinition;
    }

    get packageDefinition(): PackageDefinition | undefined {
        return this._packageDefinition;
    }

    get packageDirectory(): string | undefined {
        if (!this.packageDefinition?.path || !this.stagingDirectory) {
            return undefined;
        }

        return path.join(this.stagingDirectory, this.packageDefinition?.path);
    }

    public setBuildNumber(buildNumber: string): void {
        if (!buildNumber) {
            return;
        }

        if (this.type === PackageType.Unlocked) {
            return;
        }

        let version = this.version || this.packageDefinition?.versionNumber;

        if (!version) {
            throw new Error('The package doesnt have a version attribute, Please check your definition');
        }

        const segments = version.split('.');
        const numberToBeAppended = parseInt(buildNumber);

        if (isNaN(numberToBeAppended)) {
            throw new Error('BuildNumber should be a number');
        }

        segments[3] = buildNumber;
        this.version = segments.join('.');
    }

    public getComponentSet(): ComponentSet {
        if (!this.packageDirectory || !this.stagingDirectory) {
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

    get apexClasses(): SourceComponent[] {
        return this.getComponentSet()
            .getSourceComponents().toArray()
            .filter(c => c.type.id === 'apexclass');
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

    get triggers(): SourceComponent[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'apextrigger');
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

    get customFields(): SourceComponent[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'customfield');
    }

    get customObjects(): SourceComponent[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'customobject');
    }

    get flows(): SourceComponent[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'flow');
    }

    get profiles(): SourceComponent[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'profile');
    }

    get permissionSetGroups(): SourceComponent[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'permissionsetgroup');
    }

    get permissionSets(): SourceComponent[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'permissionset');
    }

    get standardValueSets(): SourceComponent[] {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'standardvalueset');
    }

    /**
     * @description: Gets the list of fields configured for Field Tracking History in the package
     */
    get fhtFields(): string[] {
        return this._metadata.content?.fhtFields || [];
    }

    /**
     * @description: Sets the list of fields configured for Field Tracking History in the package
     */
    public setFhtFields(names: string[]) {
        this.updateContent({
            fields: {
                fht: names
            }
        } as Partial<SfpmPackageContent>);
    }

    /**
     * @description: Gets the list of fields configured for Feed Tracking in the package
     */
    get ftFields(): string[] {
        return this._metadata.content?.ftFields || [];
    }

    /**
     * @description: Sets the list of fields configured for Feed Tracking in the package
     */
    public setFtFields(names: string[]) {
        this.updateContent({
            fields: {
                ft: names
            }
        } as Partial<SfpmPackageContent>);
    }

    get picklists() {
        return this._metadata.content?.picklists || [];
    }

    public setPicklists(picklists: string[]) {
        this.updateContent({
            fields: {
                picklists
            }
        } as Partial<SfpmPackageContent>);
    }

    public updateContent(newContent: Partial<SfpmPackageContent>) {
        _.merge(this._metadata.content, newContent);
        this.enforceIntegrity();
    }

    /**
     * Ensures every name in our categorized metadata actually 
     * exists as a physical component in the directory.
     */
    private enforceIntegrity() {
        const cs = this.getComponentSet(); //

        for (const [jsonPath, metadataType] of Object.entries(CONTENT_METADATA_TYPE)) {
            const currentList = _.get(this._metadata.content, jsonPath);

            if (!Array.isArray(currentList)) {
                continue;
            }

            const validated = currentList.filter(name => 
                cs.has({ fullName: name, type: metadataType })
            );

            _.set(this._metadata.content, jsonPath, validated);
        }
    }

    get includesProfileSupportedTypes(): boolean {
        return this.getComponentSet().getSourceComponents().toArray()
            .some(c => PROFILE_SUPPORTED_METADATA_TYPES.includes(c.type.id));
    }

    get hasDestructiveChanges(): boolean {
        return !!this._metadata.content?.destructiveChangesPath;
    }


    get isTriggerAllTests(): boolean {
        return !this.isOptimizedDeployment || this.hasApex // this.testClasses.length > 0
    }

    private get isOptimizedDeployment(): boolean {
        return (this.type === PackageType.Source && this.packageDefinition?.deploymentOptions?.optimize) || false;
    }

    set testCoverage(coverage: number) {
        this._metadata.validation.testCoverage = coverage;
    }

    get isCoverageCheckPassed(): boolean {
        return (this._metadata.validation?.testCoverage || 0) > TEST_COVERAGE_THRESHOLD;
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
                all: this.apexClasses.map(f => f.fullName),
            },
            fields: {
                all: this.customFields.map(f => f.fullName),
            },
            triggers: this.triggers.map(t => t.fullName),
            testSuites: this.testSuites,
            standardValueSets: this.standardValueSets.map(s => s.fullName),
            profiles: this.profiles.map(p => p.fullName),
            permissionSetGroups: this.permissionSetGroups.map(p => p.fullName),
            permissionSets: this.permissionSets.map(p => p.fullName),
            flows: this.flows.map(f => f.fullName)
        };
    }

    private async resolveOrchestrationMetadata(): Promise<Partial<SfpmPackageOrchestration>> {
        return {
            deploymentOptions: this.packageDefinition?.deploymentOptions,
            buildOptions: this.packageDefinition?.buildOptions
        };
    }

    /**
     * @description: Converts the package to a package metadata object.
     * @returns: A promise that resolves to the package metadata object.
     */
    public async toPackageMetadata(): Promise<SfpmPackageMetadata> {
        const content = await this.resolveContentMetadata();
        const orchestration = await this.resolveOrchestrationMetadata();

        return _.merge({}, this._metadata, {
            content,
            identity: {
                packageName: this.name || content.payload?.Package?.fullName,
                packageType: this.type || this.packageDefinition?.type,
                versionNumber: this.version || this.packageDefinition?.versionNumber
            },
            validation: {
                isTriggerAllTests: this.isTriggerAllTests,
                isCoverageCheckPassed: this.isCoverageCheckPassed,
            },
            orchestration
        });
    }

    // Override toJSON to ensure serialization is always reconciled
    public async toJSON() {
        return await this.toPackageMetadata();
    }
}