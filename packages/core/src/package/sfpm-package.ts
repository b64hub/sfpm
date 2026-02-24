import {ComponentSet, SourceComponent} from '@salesforce/source-deploy-retrieve';
import {
  get, merge, omit, set,
} from 'lodash-es';
import path from 'node:path';

import ProjectConfig from '../project/project-config.js';
import {
  MetadataFile, PackageType, SfpmPackageContent, SfpmPackageMetadata, SfpmPackageOrchestration, SfpmUnlockedPackageBuildOptions, SfpmUnlockedPackageMetadata,
} from '../types/package.js';
import {PackageDefinition, ProjectDefinition} from '../types/project.js';
import {SourceHasher} from '../utils/source-hasher.js';
import {ManagedPackageRef, VersionInstallable, type SourceDeployable} from './installers/types.js';
import { VersionManager } from '../project/version-manager.js';

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

  get apiVersion(): string {
    return this._metadata.identity.apiVersion || this.projectDefinition?.sourceApiVersion || process.env.SFPM_API_VERSION || DEFAULT_API_VERSION;
  }

  set apiVersion(val: string) {
    this._metadata.identity.apiVersion = val;
  }

  get commitId(): string | undefined {
    return this._metadata.source?.commitSHA;
  }

  get dependencies(): undefined | {package: string; versionNumber?: string}[] {
    return this.packageDefinition?.dependencies;
  }

  get metadata(): SfpmPackageMetadata {
    return this._metadata;
  }

  get name(): string {
    return this._metadata.identity.packageName;
  }

  set name(val: string) {
    this._metadata.identity.packageName = val;
  }

  get packageDefinition(): PackageDefinition | undefined {
    return this._packageDefinition;
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

  get packageDirectory(): string | undefined {
    if (!this.packageDefinition?.path || !this.stagingDirectory) {
      return undefined;
    }

    return path.join(this.stagingDirectory, this.packageDefinition?.path);
  }

  get packageName(): string {
    return this._metadata.identity.packageName;
  }

  set packageName(val: string) {
    this._metadata.identity.packageName = val;
  }

  get sourceHash(): string | undefined {
    return this._metadata.source?.sourceHash;
  }

  set sourceHash(val: string | undefined) {
    this._metadata.source = {...this._metadata.source, sourceHash: val};
  }

  get tag(): string {
    return this._metadata.source?.tag || `${this.name}@${this.version}`;
  }

  get type(): Omit<PackageType, 'managed'> {
    return this._metadata.identity.packageType;
  }

  set type(val: Omit<PackageType, 'managed'>) {
    this._metadata.identity.packageType = val;
  }

  get version(): string | undefined {
    return this._metadata.identity.versionNumber;
  }

  set version(val: string) {
    this._metadata.identity.versionNumber = VersionManager.normalizeVersion(val);
  }

  public setBuildNumber(buildNumber: string): void {
    if (!buildNumber) {
      return;
    }

    const version = this.version || this.packageDefinition?.versionNumber;

    if (!version) {
      throw new Error('The package doesnt have a version attribute, Please check your definition');
    }

    const segments = version.split('.');
    const numberToBeAppended = Number.parseInt(buildNumber, 10);

    if (Number.isNaN(numberToBeAppended)) {
      throw new TypeError('BuildNumber should be a number');
    }

    segments[3] = buildNumber;
    this.version = segments.join('.');
  }

  /**
   * @description Set orchestration options for the package build.
   * Subclasses can override to handle type-specific options.
   */
  public setOrchestrationOptions(options: any): void {
    // Base implementation does nothing - subclasses override as needed
  }

  /**
   * @description This is the package-agnostic metadata that describes the SFPM package.
   * The ArtifactAssembler is responsible for constructing the full package.json.
   *
   * @param sourceHash - Optional source hash to include
   * @returns SFPM metadata object for package.json
   */
  public async toJson(): Promise<SfpmPackageMetadata> {
    return this.metadata
  }
}

export abstract class SfpmMetadataPackage extends SfpmPackage implements SourceDeployable {
  protected _componentSet?: ComponentSet;

  get apexClasses(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents().toArray()
    .filter(c => c.type.id === 'apexclass');
  }

  /**
   * Getter exposing the cached ComponentSet for the SourceDeployable interface.
   * Delegates to getComponentSet() which initialises on first access.
   */
  get componentSet(): ComponentSet {
    return this.getComponentSet();
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
   * Gets the list of fields configured for Field Tracking History in the package
   */
  get fhtFields(): string[] {
    return this._metadata.content?.fhtFields || [];
  }

  get flows(): SourceComponent[] {
    return this.getComponentSet().getSourceComponents().toArray()
    .filter(c => c.type.id === 'flow');
  }

  /**
   * Gets the list of fields configured for Feed Tracking in the package
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

  get picklists(): string[] {
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

  get testCoverage(): number | undefined {
    return this._metadata.validation?.testCoverage;
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
   * Alias for the version property, satisfying the SourceDeployable interface.
   */
  get versionNumber(): string | undefined {
    return this.version;
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
    return this.getComponentSet().getObject();
  }

  /**
   * Sets the list of fields configured for Field Tracking History in the package
   */
  public setFhtFields(names: string[]): void {
    this.updateContent({
      fields: {
        fht: names,
      },
    } as Partial<SfpmPackageContent>);
  }

  /**
   * @description: Sets the list of fields configured for Feed Tracking in the package
   */
  public setFtFields(names: string[]): void {
    this.updateContent({
      fields: {
        ft: names,
      },
    } as Partial<SfpmPackageContent>);
  }

  public setPicklists(picklists: string[]): void {
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
   * @description Converts the package to a package metadata object.
   * @returns A promise that resolves to the package metadata object.
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

  public updateContent(newContent: Partial<SfpmPackageContent>): void {
    merge(this._metadata.content, newContent);
    this.enforceIntegrity();
  }

  /**
   * Ensures every name in our categorized metadata actually
   * exists as a physical component in the directory.
   */
  private enforceIntegrity(): void {
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
   * @description Resolves the content of the package from the component set.
   * @returns A promise that resolves to the content of the package.
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

  get packageId(): string {
    return this.metadata.identity.packageId || '';
  }

  set packageId(val: string) {
    this.metadata.identity.packageId = val;
  }

  get packageVersionId(): string | undefined {
    return this.metadata.identity.packageVersionId;
  }

  set packageVersionId(val: string | undefined) {
    this.metadata.identity.packageVersionId = val;
  }

  override setBuildNumber(buildNumber: string): void {
    return;
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
   * Create a local package by name, automatically resolving its definition and type.
   * Only creates packages that exist in packageDirectories (local source packages).
   * For managed/subscriber packages, use {@link createManagedRef} instead.
   *
   * @throws Error if the package is not found in packageDirectories or managed dependencies
   */
  createFromName(packageName: string): SfpmPackage {
    // First, try to find in packageDirectories (local packages)
    const allPackages = this.projectConfig.getAllPackageDirectories();
    const packageDefinition = allPackages.find(p => p.package === packageName);

    if (!packageDefinition) {
      // Check if it's a managed dependency — if so, guide the caller
      const managedRef = this.createManagedRef(packageName);
      if (managedRef) {
        throw new Error(`Package "${packageName}" is a managed dependency, not a local package. `
        	+ 'Use createManagedRef() instead.');
      }

      throw new Error(`Package ${packageName} not found in project definition`);
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
   * Create a lightweight ManagedPackageRef for a managed/subscriber dependency.
   * Returns undefined if the package is not found as a managed dependency.
   */
  createManagedRef(packageName: string): ManagedPackageRef | undefined {
    const managedPackages = this.projectConfig.getManagedPackages();
    const managedDef = managedPackages.find(m => m.package === packageName);

    if (!managedDef) {
      return undefined;
    }

    return new ManagedPackageRef(packageName, managedDef.packageVersionId);
  }

  /**
   * Get the underlying ProjectConfig
   */
  getProjectConfig(): ProjectConfig {
    return this.projectConfig;
  }

  /**
   * Check whether a package name refers to a managed (subscriber) dependency
   * rather than a local package directory.
   */
  isManagedPackage(packageName: string): boolean {
    const allPackages = this.projectConfig.getAllPackageDirectories();
    if (allPackages.some(p => p.package === packageName)) {
      return false;
    }

    const managedPackages = this.projectConfig.getManagedPackages();
    return managedPackages.some(m => m.package === packageName);
  }

  /**
   * Low-level factory method to create the appropriate SfpmPackage instance based on package type
   */
  private createPackageInstance(
    packageType: PackageType,
    packageName: string,
    projectDirectory: string,
  ): SfpmPackage {
    switch (packageType) {
    case PackageType.Data: {
      return new SfpmDataPackage(packageName, projectDirectory);
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
