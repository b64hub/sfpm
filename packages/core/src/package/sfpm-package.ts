import { ComponentSet } from "@salesforce/source-deploy-retrieve";
import { ProjectDefinition, PackageDefinition } from "../types/project.js";
import { PackageType, SfpmPackageContent, SfpmPackageMetadata, SfpmPackageOrchestration } from "../types/package.js";
import * as _ from "lodash";
import path from "path";


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

    set id(val: string) { this._metadata.identity.id = val; }
    get id() { return this._metadata.identity.id; }

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

    get customFields() {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'customfield');
    }

    get customObjects() {
        return this.getComponentSet().getSourceComponents().toArray()
            .filter(c => c.type.id === 'customobject');
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
        const cs = this.getComponentSet();
        // Validate names against actual set for integrity
        this._metadata.content.fhtFields = names.filter(n => 
            cs.has({ fullName: n, type: 'CustomField' })
        );
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
        const cs = this.getComponentSet();
        // Validate names against actual set for integrity
        this._metadata.content.ftFields = names.filter(n => 
            cs.has({ fullName: n, type: 'CustomField' })
        );
    }

    get picklists() {
        return this._metadata.content?.picklists || [];
    }

    public setPicklists(picklists: string[]) {
        const cs = this.getComponentSet();
        // Validate names against actual set for integrity
        this._metadata.content.picklists = picklists.filter(n => 
            cs.has({ fullName: n, type: 'CustomField' })
        );
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
            orchestration
        });
    }

    // Override toJSON to ensure serialization is always reconciled
    public async toJSON() {
        return await this.toPackageMetadata();
    }
}