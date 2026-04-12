import {ComponentSet, SourceComponent} from '@salesforce/source-deploy-retrieve';
import fg from 'fast-glob';
import {
  get, merge, omit, set,
} from 'lodash-es';
import fs from 'node:fs';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';
import type {WorkspacePackageJson} from '../types/workspace.js';

import {
  MetadataFile,
  PackageType,
  SfpmDataPackageMetadata,
  SfpmPackageContent,
  SfpmPackageMetadata,
  SfpmPackageMetadataBase,
  SfpmPackageOrchestration,
  SfpmUnlockedPackageBuildOptions,
  SfpmUnlockedPackageMetadata,
  VersionFormat,
} from '../types/package.js';
import {PackageDefinition, ProjectDefinition} from '../types/project.js';
import {DirectoryHasher} from '../utils/directory-hasher.js';
import {SourceHasher} from '../utils/source-hasher.js';
import {toVersionFormat} from '../utils/version-utils.js';
import {
  type DataDeployable,
  ManagedPackageRef,
  type SourceDeployable,
  VersionInstallable,
} from './installers/types.js';

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
  protected _metadata: SfpmPackageMetadataBase;
  protected _packageDefinition?: PackageDefinition;
  public orgDefinitionPath?: string = path.join('config', 'project-scratch-def.json');
  public projectDefinition?: ProjectDefinition;
  public projectDirectory: string;
  public stagingDirectory: string | undefined;

  constructor(packageName: string, projectDirectory: string, metadata?: Partial<SfpmPackageMetadataBase>) {
    this.projectDirectory = projectDirectory;
    this._metadata = {
      packageName,
      packageType: '',
      ...metadata?.identity,
      orchestration: {...metadata?.orchestration},
      source: {...metadata?.source},
      ...omit(metadata, ['identity', 'source', 'orchestration']),
    } as SfpmPackageMetadataBase;
  }

  get apiVersion(): string {
    return (
      this._metadata.apiVersion
      || this.projectDefinition?.sourceApiVersion
      || process.env.SFPM_API_VERSION
      || DEFAULT_API_VERSION
    );
  }

  set apiVersion(val: string) {
    this._metadata.apiVersion = val;
  }

  get commitId(): string | undefined {
    return this._metadata.source?.commitSHA;
  }

  get dependencies(): undefined | {package: string; versionNumber?: string}[] {
    return this.packageDefinition?.dependencies;
  }

  get metadata(): SfpmPackageMetadataBase {
    return this._metadata;
  }

  get name(): string {
    return this._metadata.packageName;
  }

  set name(val: string) {
    this._metadata.packageName = val;
  }

  /** Full npm-scoped name from workspace package.json (e.g., "@myorg/core-package"). Undefined in legacy mode. */
  get npmName(): string | undefined {
    return this._packageDefinition?.npmName;
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
    return this._metadata.packageName;
  }

  set packageName(val: string) {
    this._metadata.packageName = val;
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
    return this._metadata.packageType;
  }

  set type(val: Omit<PackageType, 'managed'>) {
    this._metadata.packageType = val;
  }

  get version(): string | undefined {
    return this._metadata.versionNumber;
  }

  set version(val: string) {
    this._metadata.versionNumber = toVersionFormat(val, 'semver');
  }

  /** Returns the number of deployable components (metadata) or files (data) in the package. */
  public abstract componentCount(): Promise<number>;

  /**
   * Returns the version number in the requested format.
   *
   * @param format - `'semver'` (default) for semver with hyphen (`1.0.0-NEXT`),
   *                 `'salesforce'` for 4-part dot-separated (`1.0.0.NEXT`).
   * @param options.includeBuildNumber - Whether to include the build segment
   *                                     (default: `true`). When `false`, returns
   *                                     only `major.minor.patch`.
   * @returns Formatted version string, or `undefined` if no version is set.
   */
  public getVersionNumber(
    format: VersionFormat = 'semver',
    options?: {includeBuildNumber?: boolean},
  ): string | undefined {
    const raw = this.version;
    if (!raw) return undefined;
    return toVersionFormat(raw, format, {includeBuildNumber: options?.includeBuildNumber});
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
  public async toJson(): Promise<SfpmPackageMetadataBase> {
    return this.metadata;
  }
}

export abstract class SfpmMetadataPackage extends SfpmPackage implements SourceDeployable {
  protected _componentSet?: ComponentSet;
  declare protected _metadata: SfpmPackageMetadata;
  private _customFields?: SourceComponent[];

  constructor(packageName: string, projectDirectory: string, metadata?: Partial<SfpmPackageMetadata>) {
    super(packageName, projectDirectory, metadata);
    // Ensure content section exists
    this._metadata.content = {...metadata?.content} as SfpmPackageContent;
  }

  get apexClasses(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
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
    if (!this._customFields) {
      this._customFields = this.resolveCustomFields();
    }

    return this._customFields;
  }

  get customObjects(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .filter(c => c.type.id === 'customobject');
  }

  /**
   * Gets the list of fields configured for Field Tracking History in the package
   */
  get fhtFields(): string[] {
    return this._metadata.content?.fhtFields || [];
  }

  get flows(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
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
    .getSourceComponents()
    .toArray()
    .some(c => apexTypes.has(c.type.id));
  }

  get hasDestructiveChanges(): boolean {
    return Boolean(this._metadata.content?.destructiveChangesPath);
  }

  get hasPermissionSetGroups(): boolean {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .some(c => c.type.id === 'permissionsetgroup');
  }

  get hasProfiles(): boolean {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .some(c => c.type.id === 'profile');
  }

  get includesProfileSupportedTypes(): boolean {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .some(c => PROFILE_SUPPORTED_METADATA_TYPES.has(c.type.id));
  }

  get isCoverageCheckPassed(): boolean {
    return (this._metadata.content?.testCoverage || 0) > TEST_COVERAGE_THRESHOLD;
  }

  private get isOptimizedDeployment(): boolean {
    return (this.type === PackageType.Source && this.packageDefinition?.packageOptions?.deploy?.optimize) || false;
  }

  get isTriggerAllTests(): boolean {
    return this._metadata.orchestration?.install?.isTriggerAllTests || !this.isOptimizedDeployment || this.hasApex;
  }

  set isTriggerAllTests(val: boolean) {
    if (!this._metadata.orchestration.install) {
      this._metadata.orchestration.install = {};
    }

    this._metadata.orchestration.install.isTriggerAllTests = val;
  }

  get permissionSetGroups(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .filter(c => c.type.id === 'permissionsetgroup');
  }

  get permissionSets(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .filter(c => c.type.id === 'permissionset');
  }

  get picklists(): string[] {
    return this._metadata.content?.picklists || [];
  }

  get profiles(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .filter(c => c.type.id === 'profile');
  }

  get standardValueSets(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .filter(c => c.type.id === 'standardvalueset');
  }

  get testClasses(): MetadataFile[] {
    return this._metadata.content?.apex?.tests || [];
  }

  get testCoverage(): number | undefined {
    return this._metadata.content?.testCoverage;
  }

  set testCoverage(coverage: number) {
    this._metadata.content.testCoverage = coverage;
  }

  get testSuites(): string[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .filter(c => c.type.id === 'testsuite')
    .map(c => c.fullName);
  }

  get triggers(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
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

  /** Returns the number of metadata components in the package. */
  public async componentCount(): Promise<number> {
    return this.getComponentSet().size;
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

    const metadata = merge({}, this._metadata, {
      content,
      orchestration: {
        ...orchestration,
        // Persist only build properties that describe artifact state, not runtime parameters
        build: {
          ...(this._metadata.orchestration?.build?.isCoverageEnabled !== undefined && {
            isCoverageEnabled: this._metadata.orchestration.build.isCoverageEnabled,
          }),
        },
        install: {
          ...orchestration.install,
          isTriggerAllTests: this.isTriggerAllTests,
        },
      },
      packageName: this.name || content.payload?.Package?.fullName,
      packageType: this.type || this.packageDefinition?.type,
      versionNumber: this.version || this.packageDefinition?.versionNumber,
    });

    return metadata;
  }

  public updateContent(newContent: Partial<SfpmPackageContent>): void {
    merge(this._metadata.content, newContent);
    this.enforceIntegrity();
  }

  /**
   * Ensures every name in our categorized metadata actually
   * exists as a physical component in the directory.
   *
   * Uses a pre-built lookup that includes child components (e.g. CustomField
   * children of CustomObject) because ComponentSet.has() only resolves
   * parent relationships when `type` is a MetadataType object, not a string.
   */
  private enforceIntegrity(): void {
    const cs = this.getComponentSet();

    // Build a lookup of all component fullNames by type ID, including children.
    const knownComponents = new Map<string, Set<string>>();
    for (const component of cs.getSourceComponents().toArray()) {
      const typeId = component.type.id.toLowerCase();
      if (!knownComponents.has(typeId)) {
        knownComponents.set(typeId, new Set());
      }

      knownComponents.get(typeId)!.add(component.fullName);

      for (const child of component.getChildren()) {
        const childTypeId = child.type.id.toLowerCase();
        if (!knownComponents.has(childTypeId)) {
          knownComponents.set(childTypeId, new Set());
        }

        knownComponents.get(childTypeId)!.add(child.fullName);
      }
    }

    for (const [jsonPath, metadataType] of Object.entries(CONTENT_METADATA_TYPE)) {
      const currentList = get(this._metadata.content, jsonPath);

      if (!Array.isArray(currentList)) {
        continue;
      }

      const typeFullNames = knownComponents.get(metadataType.toLowerCase()) ?? new Set();
      const validated = currentList.filter(item => {
        // Support both string[] and MetadataFile[] ({ name, path })
        const name = typeof item === 'string' ? item : item.name;
        return typeFullNames.has(name);
      });

      set(this._metadata.content, jsonPath, validated);
    }
  }

  /**
   * @description Resolves the content of the package from the component set,
   * preserving any field/apex metadata already set by analyzers.
   * @returns A promise that resolves to the content of the package.
   */
  private async resolveContentMetadata(): Promise<SfpmPackageContent> {
    const cs = this.getComponentSet();
    const components = cs.getSourceComponents();

    return {
      ...this._metadata.content,
      metadataCount: components.toArray().length,
      payload: await cs.getObject(),
      testCoverage: this.testCoverage,
    };
  }

  /**
   * Resolves all CustomField components, including children of decomposed
   * CustomObject components. Deduplicates by fullName.
   */
  private resolveCustomFields(): SourceComponent[] {
    const sourceComponents: SourceComponent[] = this.getComponentSet().getSourceComponents().toArray();

    // Deduplicate by fullName — a field may appear as both a top-level
    // CustomField and as a child of a CustomObject in decomposed source.
    const fieldMap = new Map<string, SourceComponent>();

    for (const c of sourceComponents) {
      if (c.type.id.toLowerCase() === 'customfield') {
        fieldMap.set(c.fullName, c);
      }
    }

    for (const component of sourceComponents) {
      if (component.type.id.toLowerCase() === 'customobject') {
        for (const child of component.getChildren()) {
          if (child.type.id.toLowerCase() === 'customfield' && !fieldMap.has(child.fullName)) {
            fieldMap.set(child.fullName, child);
          }
        }
      }
    }

    return [...fieldMap.values()];
  }

  private async resolveOrchestrationMetadata(): Promise<Partial<SfpmPackageOrchestration>> {
    return {
      build: this.packageDefinition?.packageOptions?.build as any,
      install: this.packageDefinition?.packageOptions?.deploy,
    };
  }
}

export class SfpmDataPackage extends SfpmPackage implements DataDeployable {
  constructor(packageName: string, projectDirectory: string, metadata?: Partial<SfpmPackageMetadataBase>) {
    super(packageName, projectDirectory, metadata);
    this._metadata.packageType = PackageType.Data;
  }

  /**
   * Absolute path to the data directory.
   * Before staging: resolves from project source.
   * After staging: resolves from the staging area.
   */
  get dataDirectory(): string {
    const packagePath = this.packageDefinition?.path;
    if (!packagePath) {
      throw new Error('Data package must have a path defined in packageDefinition');
    }

    if (this.stagingDirectory) {
      return path.join(this.stagingDirectory, packagePath);
    }

    return path.join(this.projectDirectory, packagePath);
  }

  override get metadata(): SfpmPackageMetadataBase {
    return this._metadata;
  }

  /**
   * Alias for the version property, satisfying the DataDeployable interface.
   */
  get versionNumber(): string | undefined {
    return this.version;
  }

  /**
   * Calculate source hash by hashing all files in the data directory recursively.
   * This is content-agnostic — it hashes every file regardless of type.
   */
  public async calculateSourceHash(): Promise<string> {
    const hash = await DirectoryHasher.calculate(this.dataDirectory);
    this.sourceHash = hash;
    return hash;
  }

  /** Returns the number of data files in the package. */
  public async componentCount(): Promise<number> {
    const files = await fg(['**/*'], {
      cwd: this.dataDirectory,
      dot: false,
      onlyFiles: true,
    });
    return files.length;
  }

  override async toJson(): Promise<SfpmDataPackageMetadata> {
    const fileCount = await this.componentCount();

    return {
      content: {
        dataDirectory: this.packageDefinition?.path || '',
        fileCount,
      },
      orchestration: {
        build: this.packageDefinition?.packageOptions?.build as any,
        install: this.packageDefinition?.packageOptions?.install as any,
      },
      packageName: this.name,
      packageType: PackageType.Data,
      source: this._metadata.source,
      versionNumber: this.version,
    };
  }
}

export class SfpmUnlockedPackage extends SfpmMetadataPackage {
  constructor(packageName: string, projectDirectory: string, metadata?: Partial<SfpmUnlockedPackageMetadata>) {
    super(packageName, projectDirectory, metadata);
    this._metadata.packageType = PackageType.Unlocked;
  }

  get isOrgDependent(): boolean {
    return this.metadata.isOrgDependent;
  }

  set isOrgDependent(val: boolean) {
    this.metadata.isOrgDependent = val;
  }

  override get metadata(): SfpmUnlockedPackageMetadata {
    return this._metadata as SfpmUnlockedPackageMetadata;
  }

  get packageId(): string {
    return this.metadata.packageId || '';
  }

  set packageId(val: string) {
    this.metadata.packageId = val;
  }

  get packageVersionId(): string | undefined {
    return this.metadata.packageVersionId;
  }

  set packageVersionId(val: string | undefined) {
    this.metadata.packageVersionId = val;
  }

  override setBuildNumber(buildNumber: string): void {}

  override setOrchestrationOptions(options: Partial<SfpmUnlockedPackageBuildOptions>): void {
    if (options.installationKey === undefined) {
      set(this.metadata, 'orchestration.build.installationKeyBypass', true);
    } else {
      set(this.metadata, 'orchestration.build.installationKey', options.installationKey);
    }

    if (options.isSkipValidation !== undefined) {
      set(this.metadata, 'orchestration.build.isSkipValidation', options.isSkipValidation);
    }

    if (options.isAsyncValidation !== undefined) {
      set(this.metadata, 'orchestration.build.isAsyncValidation', options.isAsyncValidation);
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

export class SfpmSourcePackage extends SfpmMetadataPackage {}

/**
 * Factory for creating fully-configured SfpmPackage instances from a ProjectDefinitionProvider.
 * Bridges the provider interface with package construction.
 */
export class PackageFactory {
  private provider: ProjectDefinitionProvider;

  constructor(provider: ProjectDefinitionProvider) {
    this.provider = provider;
  }

  /**
   * Create packages for all package directories in the project
   */
  createAll(): SfpmPackage[] {
    const packageNames = this.provider.getAllPackageNames();
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
    const allPackages = this.provider.getAllPackageDefinitions();
    const packageDefinition = allPackages.find(p => p.package === packageName);

    if (!packageDefinition) {
      // Check if it's a managed dependency — if so, guide the caller
      const managedRef = this.createManagedRef(packageName);
      if (managedRef) {
        throw new Error(`Package "${packageName}" is a managed dependency, not a local package. Use createManagedRef() instead.`);
      }

      throw new Error(`Package ${packageName} not found in project definition`);
    }

    const packageType = (packageDefinition.type?.toLowerCase() || 'unlocked') as PackageType;
    const projectDirectory = this.provider.projectDir;

    const sfpmPackage = this.createPackageInstance(packageType, packageName, projectDirectory);

    // Populate from project config
    sfpmPackage.projectDefinition = this.provider.getProjectDefinition();
    sfpmPackage.packageDefinition = packageDefinition;
    sfpmPackage.version = packageDefinition.versionNumber;

    // In workspace mode, read packageOptions directly from the workspace package.json
    // rather than from sfdx-project.json (which no longer carries them)
    this.overlayWorkspacePackageOptions(packageDefinition, sfpmPackage);

    // Resolve package ID from aliases for unlocked packages
    if (packageType === PackageType.Unlocked && sfpmPackage instanceof SfpmUnlockedPackage) {
      const projectDef = this.provider.getProjectDefinition();
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
    const packageDefinition = this.provider.getPackageDefinitionByPath(packagePath);
    return this.createFromName(packageDefinition.package);
  }

  /**
   * Create a lightweight ManagedPackageRef for a managed/subscriber dependency.
   * Returns undefined if the package is not found as a managed dependency.
   */
  createManagedRef(packageName: string): ManagedPackageRef | undefined {
    const managedPackages = this.provider.getManagedPackages();
    const managedDef = managedPackages.find(m => m.package === packageName);

    if (!managedDef) {
      return undefined;
    }

    return new ManagedPackageRef(packageName, managedDef.packageVersionId);
  }

  /**
   * Get the underlying ProjectDefinitionProvider
   */
  getProvider(): ProjectDefinitionProvider {
    return this.provider;
  }

  /**
   * Check whether a package name refers to a managed (subscriber) dependency
   * rather than a local package directory.
   */
  isManagedPackage(packageName: string): boolean {
    const allPackages = this.provider.getAllPackageDefinitions();
    if (allPackages.some(p => p.package === packageName)) {
      return false;
    }

    const managedPackages = this.provider.getManagedPackages();
    return managedPackages.some(m => m.package === packageName);
  }

  /**
   * Low-level factory method to create the appropriate SfpmPackage instance based on package type
   */
  private createPackageInstance(packageType: PackageType, packageName: string, projectDirectory: string): SfpmPackage {
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

  /**
   * Detect workspace package.json and overlay packageOptions onto the PackageDefinition.
   *
   * In workspace mode, packageOptions lives in the package-scoped package.json
   * (not in sfdx-project.json). This method finds the workspace package.json
   * by walking up from the SF source path and merges packageOptions onto the
   * existing PackageDefinition so all downstream consumers work unchanged.
   */
  private overlayWorkspacePackageOptions(packageDefinition: PackageDefinition, sfpmPackage: SfpmPackage): void {
    const {projectDir} = this.provider;
    const sourcePath = packageDefinition.path;
    const parts = sourcePath.split('/');

    // Walk up from the source path to find a package.json with sfpm config
    for (let i = parts.length; i > 0; i--) {
      const candidatePath = path.join(projectDir, ...parts.slice(0, i), 'package.json');
      try {
        if (fs.existsSync(candidatePath)) {
          const pkgJson: WorkspacePackageJson = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
          if (pkgJson.sfpm?.packageType && pkgJson.sfpm.packageOptions) {
            packageDefinition.packageOptions = pkgJson.sfpm.packageOptions;
            return;
          }
        }
      } catch {
        // Detection failed — continue to next candidate
      }
    }
  }
}
