import {ComponentSet, SourceComponent} from '@salesforce/source-deploy-retrieve';
import {
  get, merge, omit, set,
} from 'lodash-es';
import path from 'node:path';

import ProjectConfig from '../project/project-config.js';
import {NpmPackageSfpmMetadata} from '../types/npm.js';
import {
  MetadataFile, PackageType, SfpmPackageContent, SfpmPackageMetadata, SfpmPackageOrchestration, SfpmUnlockedPackageBuildOptions, SfpmUnlockedPackageMetadata,
} from '../types/package.js';
import {ManagedPackageDefinition, PackageDefinition, ProjectDefinition} from '../types/project.js';
import {SourceHasher} from '../utils/source-hasher.js';

const TEST_COVERAGE_THRESHOLD = 75;
const DEFAULT_API_VERSION = '65.0';
/**
 * Internal map used by SfpmPackage to validate component identities.
 */
const CONTENT_METADATA_TYPE: Record<string, string> = {
  'apex.classes': 'ApexClass',
  'apex.tests': 'ApexClass',
  'fields.fht': 'CustomField',
  'fields.ft': 'CustomField',
  'fields.picklists': 'CustomField',
  permissionSetGroups: 'PermissionSetGroup',
  permissionSets: 'PermissionSet',
  profiles: 'Profile',
  standardValueSets: 'StandardValueSet',
  triggers: 'ApexTrigger',
};

const PROFILE_SUPPORTED_METADATA_TYPES = new Set([
  'apexclass',
  'apexpage',
  'customapplication',
  'customfield',
  'customobject',
  'customtab',
  'layout',
  'recordtype',
  'systempermissions',
]);

export default abstract class SfpmPackage {
  protected _metadata: SfpmPackageMetadata;
  protected _packageDefinition?: PackageDefinition;
  public orgDefinitionPath?: string = path.join('config', 'project-scratch-def.json');
  public projectDefinition?: ProjectDefinition;
  public projectDirectory: string;
  public stagingDirectory: string | undefined;

  constructor(packageName: string, projectDirectory: string, metadata?: Partial<SfpmPackageMetadata>) {
    this.projectDirectory = projectDirectory;
    this._metadata = {
      content: {...metadata?.content},
      identity: {
        packageName,
        packageType: '',
        ...metadata?.identity,
      },
      orchestration: {...metadata?.orchestration},
      source: {...metadata?.source},
      validation: {...metadata?.validation},
      ...omit(metadata, ['identity', 'source', 'content', 'validation', 'orchestration']),
    } as SfpmPackageMetadata;
  }

  get apiVersion() {
    return this._metadata.identity.apiVersion || this.projectDefinition?.sourceApiVersion || process.env.SFPM_API_VERSION || DEFAULT_API_VERSION;
  }

  set apiVersion(val: string) {
    this._metadata.identity.apiVersion = val;
  }

  get commitId() {
    return this._metadata.source?.commitSHA;
  }

  get dependencies(): undefined | {package: string; versionNumber?: string}[] {
    return this.packageDefinition?.dependencies;
  }

  get metadata(): SfpmPackageMetadata {
    return this._metadata;
  }

  get name() {
    return this._metadata.identity.packageName;
  }

  set name(val: string) {
    this._metadata.identity.packageName = val;
  }

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

  get packageName() {
    return this._metadata.identity.packageName;
  }

  set packageName(val: string) {
    this._metadata.identity.packageName = val;
  }

  get sourceHash() {
    return this._metadata.source?.sourceHash;
  }

  set sourceHash(val: string | undefined) {
    this._metadata.source = {...this._metadata.source, sourceHash: val};
  }

  get tag() {
    return this._metadata.source?.tag || `${this.name}@${this.version}`;
  }

  get type() {
    return this._metadata.identity.packageType;
  }

  set type(val: Omit<PackageType, 'managed'>) {
    this._metadata.identity.packageType = val;
  }

  get version() {
    return this._metadata.identity.versionNumber;
  }

  set version(val: string | undefined) {
    this._metadata.identity.versionNumber = val;
  }

  public setBuildNumber(buildNumber: string): void {
    if (!buildNumber) {
      return;
    }

    if (this.type === PackageType.Unlocked) {
      return;
    }

    const version = this.version || this.packageDefinition?.versionNumber;

    if (!version) {
      throw new Error('The package doesnt have a version attribute, Please check your definition');
    }

    const segments = version.split('.');
    const numberToBeAppended = Number.parseInt(buildNumber);

    if (isNaN(numberToBeAppended)) {
      throw new TypeError('BuildNumber should be a number');
    }

    segments[3] = buildNumber;
    this.version = segments.join('.');
  }

  /**
   * Set orchestration options for the package build.
   * Subclasses can override to handle type-specific options.
   */
  public setOrchestrationOptions(options: any): void {
    // Base implementation does nothing - subclasses override as needed
  }

  /**
   * This is the package-agnostic metadata that describes the SFPM package.
   * The ArtifactAssembler is responsible for constructing the full package.json.
   *
   * @param sourceHash - Optional source hash to include
   * @returns SFPM metadata object for package.json
   */
  public async toJson(): Promise<SfpmPackageMetadata> {
    return this.metadata
  }
}

export abstract class SfpmMetadataPackage extends SfpmPackage {
  protected _componentSet?: ComponentSet;

  get apexClasses(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents().toArray()
    .filter(c => c.type.id === 'apexclass');
  }

  get customFields(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'customfield');
  }

  get customObjects(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'customobject');
  }

  /**
   * @description: Gets the list of fields configured for Field Tracking History in the package
   */
  get fhtFields(): string[] {
    return this._metadata.content?.fhtFields || [];
  }

  get flows(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'flow');
  }

  /**
   * @description: Gets the list of fields configured for Feed Tracking in the package
   */
  get ftFields(): string[] {
    return this._metadata.content?.ftFields || [];
  }

  get hasApex(): boolean {
    const apexTypes = new Set(['apexclass', 'apextrigger']);
    return this.getComponentSet()
    .getSourceComponents().toArray()
    .some(c => apexTypes.has(c.type.id));
  }

  get hasDestructiveChanges(): boolean {
    return Boolean(this._metadata.content?.destructiveChangesPath);
  }

  get hasPermissionSetGroups(): boolean {
    return this.getComponentSet().getSourceComponents().toArray()
    .some(c => c.type.id === 'permissionsetgroup');
  }

  get hasProfiles(): boolean {
    return this.getComponentSet().getSourceComponents().toArray()
    .some(c => c.type.id === 'profile');
  }

  get includesProfileSupportedTypes(): boolean {
    return this.getComponentSet().getSourceComponents().toArray()
    .some(c => PROFILE_SUPPORTED_METADATA_TYPES.has(c.type.id));
  }

  get isCoverageCheckPassed(): boolean {
    return (this._metadata.validation?.testCoverage || 0) > TEST_COVERAGE_THRESHOLD;
  }

  private get isOptimizedDeployment(): boolean {
    return (this.type === PackageType.Source && this.packageDefinition?.packageOptions?.deploy?.optimize) || false;
  }

  get isTriggerAllTests(): boolean {
    return this._metadata.validation.isTriggerAllTests || (!this.isOptimizedDeployment || this.hasApex)
  }

  set isTriggerAllTests(val: boolean) {
    this._metadata.validation.isTriggerAllTests = val;
  }

  get permissionSetGroups(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'permissionsetgroup');
  }

  get permissionSets(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'permissionset');
  }

  get picklists() {
    return this._metadata.content?.picklists || [];
  }

  get profiles(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'profile');
  }

  get standardValueSets(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'standardvalueset');
  }

  get testClasses(): MetadataFile[] {
    return this._metadata.content?.apex?.tests || [];
  }

  set testCoverage(coverage: number) {
    this._metadata.validation.testCoverage = coverage;
  }

  get testSuites(): string[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'testsuite')
    .map(c => c.fullName);
  }

  get triggers(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'apextrigger');
  }

  /**
   * Calculate and set the source hash for this package.
   * Uses ComponentSet to ensure consistency with .forceignore rules.
   * @returns The calculated source hash
   */
  public async calculateSourceHash(): Promise<string> {
    const hash = await SourceHasher.calculate(this);
    this.sourceHash = hash;
    return hash;
  }

  public getComponentSet(): ComponentSet {
    if (!this.packageDirectory || !this.stagingDirectory) {
      throw new Error('Package must be staged for build and have a defined path');
    }

    if (!this._componentSet) {
      this._componentSet = ComponentSet.fromSource(this.packageDirectory);
    }

    return this._componentSet;
  }

  /**
   * Returns the logical manifest of the package as a JSON-compatible object.
   */
  public async getManifestObject() {
    return await this.getComponentSet().getObject();
  }

  /**
   * @description: Sets the list of fields configured for Field Tracking History in the package
   */
  public setFhtFields(names: string[]) {
    this.updateContent({
      fields: {
        fht: names,
      },
    } as Partial<SfpmPackageContent>);
  }

  /**
   * @description: Sets the list of fields configured for Feed Tracking in the package
   */
  public setFtFields(names: string[]) {
    this.updateContent({
      fields: {
        ft: names,
      },
    } as Partial<SfpmPackageContent>);
  }

  public setPicklists(picklists: string[]) {
    this.updateContent({
      fields: {
        picklists,
      },
    } as Partial<SfpmPackageContent>);
  }

  // Override toJSON to ensure serialization is always reconciled
  override async toJson(): Promise<SfpmPackageMetadata> {
    const baseMetadata = await super.toJson();
    return {
      ...baseMetadata,
      ...(await this.toPackageMetadata()),
    };
  }

  /**
   * @description: Converts the package to a package metadata object.
   * @returns: A promise that resolves to the package metadata object.
   */
  public async toPackageMetadata(): Promise<SfpmPackageMetadata> {
    const content = await this.resolveContentMetadata();
    const orchestration = await this.resolveOrchestrationMetadata();

    return merge({}, this._metadata, {
      content,
      identity: {
        packageName: this.name || content.payload?.Package?.fullName,
        packageType: this.type || this.packageDefinition?.type,
        versionNumber: this.version || this.packageDefinition?.versionNumber,
      },
      orchestration,
      validation: {
        isCoverageCheckPassed: this.isCoverageCheckPassed,
        isTriggerAllTests: this.isTriggerAllTests,
      },
    });
  }

  public updateContent(newContent: Partial<SfpmPackageContent>) {
    merge(this._metadata.content, newContent);
    this.enforceIntegrity();
  }

  /**
   * Ensures every name in our categorized metadata actually
   * exists as a physical component in the directory.
   */
  private enforceIntegrity() {
    const cs = this.getComponentSet(); //

    for (const [jsonPath, metadataType] of Object.entries(CONTENT_METADATA_TYPE)) {
      const currentList = get(this._metadata.content, jsonPath);

      if (!Array.isArray(currentList)) {
        continue;
      }

      const validated = currentList.filter(item => {
        // Support both string[] and MetadataFile[] ({ name, path })
        const name = typeof item === 'string' ? item : item.name;
        return cs.has({fullName: name, type: metadataType});
      });

      set(this._metadata.content, jsonPath, validated);
    }
  }

  /**
   * @description: Resolves the content of the package from the component set.
   * @returns: A promise that resolves to the content of the package.
   */
  private async resolveContentMetadata(): Promise<SfpmPackageContent> {
    const cs = this.getComponentSet();
    const components = cs.getSourceComponents();

    return {
      apex: {
        all: this.apexClasses.map(f => f.fullName),
      },
      fields: {
        all: this.customFields.map(f => f.fullName),
      },
      flows: this.flows.map(f => f.fullName),
      metadataCount: components.toArray().length,
      payload: await cs.getObject(),
      permissionSetGroups: this.permissionSetGroups.map(p => p.fullName),
      permissionSets: this.permissionSets.map(p => p.fullName),
      profiles: this.profiles.map(p => p.fullName),
      standardValueSets: this.standardValueSets.map(s => s.fullName),
      testSuites: this.testSuites,
      triggers: this.triggers.map(t => t.fullName),
    };
  }

  private async resolveOrchestrationMetadata(): Promise<Partial<SfpmPackageOrchestration>> {
    return {
      buildOptions: this.packageDefinition?.packageOptions?.build as any,
      deploymentOptions: this.packageDefinition?.packageOptions?.deploy,
    };
  }
}

export class SfpmDataPackage extends SfpmPackage {
}

export class SfpmUnlockedPackage extends SfpmMetadataPackage {
  constructor(packageName: string, projectDirectory: string, metadata?: Partial<SfpmUnlockedPackageMetadata>) {
    super(packageName, projectDirectory, metadata);
    this._metadata.identity.packageType = PackageType.Unlocked;
  }

  get isOrgDependent(): boolean {
    return this.metadata.identity.isOrgDependent;
  }

  set isOrgDependent(val: boolean) {
    this.metadata.identity.isOrgDependent = val;
  }

  override get metadata(): SfpmUnlockedPackageMetadata {
    return this._metadata as SfpmUnlockedPackageMetadata;
  }

  set packageId(val: string) {
    this.metadata.identity.packageId = val;
  }

  get packageId() {
    return this.metadata.identity.packageId || '';
  }

  get packageVersionId(): string | undefined {
    return this.metadata.identity.packageVersionId;
  }

  set packageVersionId(val: string | undefined) {
    this.metadata.identity.packageVersionId = val;
  }

  override setOrchestrationOptions(options: Partial<SfpmUnlockedPackageBuildOptions>): void {
    if (options.installationkey !== undefined) {
      set(this.metadata, 'orchestration.buildOptions.installationkey', options.installationkey);
    }

    if (options.installationkeybypass !== undefined) {
      set(this.metadata, 'orchestration.buildOptions.installationkeybypass', options.installationkeybypass);
    }

    if (options.isSkipValidation !== undefined) {
      set(this.metadata, 'orchestration.buildOptions.isSkipValidation', options.isSkipValidation);
    }
  }

  /**
   * Override to ensure unlocked-package-specific identity fields are populated.
   * Package identity (packageId, packageVersionId, isOrgDependent) is stored
   * exclusively under sfpm.identity — no top-level duplicates.
   */
  override async toJson(): Promise<SfpmPackageMetadata> {
    return super.toJson();
  }
}

export class SfpmSourcePackage extends SfpmMetadataPackage {

}

/**
 * Lightweight package representing an external managed/subscriber package.
 * These packages have no local source — only a name and a packageVersionId
 * (04t subscriber package version ID) resolved from packageAliases.
 *
 * Managed packages are installed via version-install (Tooling API), never deployed as source.
 */
export class SfpmManagedPackage extends SfpmPackage {
  private readonly _packageVersionId: string;

  constructor(packageName: string, projectDirectory: string, packageVersionId: string) {
    super(packageName, projectDirectory, {
      identity: {
        packageName,
        packageType: PackageType.Managed as any,
      },
    } as Partial<SfpmPackageMetadata>);
    this._packageVersionId = packageVersionId;
  }

  get packageVersionId(): string {
    return this._packageVersionId;
  }
}

/**
 * Factory for creating fully-configured SfpmPackage instances from ProjectConfig.
 * Bridges ProjectConfig (sfdx-project.json abstraction) with package construction.
 */
export class PackageFactory {
  private projectConfig: ProjectConfig;

  constructor(projectConfig: ProjectConfig) {
    this.projectConfig = projectConfig;
  }

  /**
   * Create packages for all package directories in the project
   */
  createAll(): SfpmPackage[] {
    const packageNames = this.projectConfig.getAllPackageNames();
    return packageNames.map(name => this.createFromName(name));
  }

  /**
   * Create a package by name, automatically resolving its definition and type.
   * Falls back to managed packages if not found in packageDirectories.
   */
  createFromName(packageName: string): SfpmPackage {
    // First, try to find in packageDirectories (local packages)
    const allPackages = this.projectConfig.getAllPackageDirectories();
    const packageDefinition = allPackages.find(p => p.package === packageName);

    if (!packageDefinition) {
      // Fallback: check managed packages
      return this.createManagedPackage(packageName);
    }

    const packageType = (packageDefinition.type?.toLowerCase() || 'unlocked') as PackageType;
    const {projectDirectory} = this.projectConfig;

    const sfpmPackage = this.createPackageInstance(packageType, packageName, projectDirectory);

    // Populate from project config
    sfpmPackage.projectDefinition = this.projectConfig.getProjectDefinition();
    sfpmPackage.packageDefinition = packageDefinition;
    sfpmPackage.version = packageDefinition.versionNumber;

    // Resolve package ID from aliases for unlocked packages
    if (packageType === PackageType.Unlocked && sfpmPackage instanceof SfpmUnlockedPackage) {
      const projectDef = this.projectConfig.getProjectDefinition();
      const packageId = projectDef.packageAliases?.[packageName];
      if (packageId) {
        sfpmPackage.packageId = packageId;
      }
    }

    return sfpmPackage;
  }

  /**
   * Create a package by path, resolving which package it belongs to
   */
  createFromPath(packagePath: string): SfpmPackage {
    const packageDefinition = this.projectConfig.getPackageDefinitionByPath(packagePath);
    return this.createFromName(packageDefinition.package);
  }

  /**
   * Get the underlying ProjectConfig
   */
  getProjectConfig(): ProjectConfig {
    return this.projectConfig;
  }

  /**
   * Create a managed package from the project's managed package definitions.
   * @throws Error if the package is not found as a managed dependency
   */
  private createManagedPackage(packageName: string): SfpmManagedPackage {
    const managedPackages = this.projectConfig.getManagedPackages();
    const managedDef = managedPackages.find(m => m.package === packageName);

    if (!managedDef) {
      throw new Error(`Package ${packageName} not found in project definition or managed dependencies`);
    }

    const {projectDirectory} = this.projectConfig;
    return this.createPackageInstance(
      PackageType.Managed,
      packageName,
      projectDirectory,
      managedDef,
    ) as SfpmManagedPackage;
  }

  /**
   * Low-level factory method to create the appropriate SfpmPackage instance based on package type
   */
  private createPackageInstance(
    packageType: PackageType,
    packageName: string,
    projectDirectory: string,
    managedDef?: ManagedPackageDefinition,
  ): SfpmPackage {
    switch (packageType) {
    case PackageType.Data: {
      return new SfpmDataPackage(packageName, projectDirectory);
    }

    case PackageType.Managed: {
      if (!managedDef) {
        throw new Error(`Managed package definition required for: ${packageName}`);
      }

      return new SfpmManagedPackage(packageName, projectDirectory, managedDef.packageVersionId);
    }

    case PackageType.Source: {
      return new SfpmSourcePackage(packageName, projectDirectory);
    }

    case PackageType.Unlocked: {
      return new SfpmUnlockedPackage(packageName, projectDirectory);
    }

    default: {
      throw new Error(`Unsupported package type: ${packageType}`);
    }
    }
  }
}
