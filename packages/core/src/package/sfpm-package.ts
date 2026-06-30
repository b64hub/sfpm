import {ComponentSet, SourceComponent} from '@salesforce/source-deploy-retrieve';
import fg from 'fast-glob';
import {
  get, merge, set,
} from 'lodash-es';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../project/providers/project-definition-provider.js';
import type {Logger} from '../types/logger.js';

import {FORCE_APP_DIR} from '../types/artifact.js';
import {
  MetadataFile,
  PackageType,
  SfpmPackageContent,
  SfpmPackageOrchestration,
  SfpmUnlockedPackageMetadata,
  type TestLevel,
  VersionFormat,
} from '../types/package.js';
import {OrgAliasConfig, PackageDefin../types/types.jsion} from '../types/project.js';
import {extractScope, joinPackageName, stripScope} from '../utils/scope-utils.js';
import {toVersionFormat} from '../utils/version-utils.js';
import {AnalyzerRegistry} from './analyzers/analyzer-registry.js';
import {
  type DataDeployable,
  ManagedPackageRef,
  type SourceDeployable,
  type VersionInstallable,
} from './installers/types.js';
import {ORG_ALIAS_DEFAULT_DIR, OrgAliasResolution, OrgAliasResolver} from './org-alias-resolver.js';
import {type ValidationState} from './validation/types.js';

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
  protected _packageDefinition?: PackageDefinition;
  public orchestration: SfpmPackageOrchestration;
  public orgDefinitionPath?: string = path.join('config', 'project-scratch-def.json');
  public projectDefinition?: ProjectDefinition;
  public projectDirectory: string;
  public readonly scope: string | undefined;
  public sourceHash?: string;
  public workingDirectory: string | undefined;
  private _apiVersion?: string;
  private _packageName: string;
  private _packageType!: Omit<PackageType, 'managed'>;
  private _versionNumber?: string;

  constructor(packageName: string, projectDirectory: string) {
    this.projectDirectory = projectDirectory;
    this._packageName = stripScope(packageName);
    this.scope = extractScope(packageName);
    this.orchestration = {} as SfpmPackageOrchestration;
  }

  get apiVersion(): string {
    return (
      this._apiVersion
      || this.projectDefinition?.sourceApiVersion
      || process.env.SFPM_API_VERSION
      || DEFAULT_API_VERSION
    );
  }

  set apiVersion(val: string) {
    this._apiVersion = val;
  }

  get dependencies(): undefined | {[packageName: string]: string} {
    return this.packageDefinition?.dependencies;
  }

  /** Full npm-scoped name from workspace package.json (e.g., "@myorg/core-package") */
  get name(): string {
    return joinPackageName(this.packageName, this.scope);
  }

  get packageDefinition(): PackageDefinition | undefined {
    return this._packageDefinition;
  }

  set packageDefinition(packageDefinition: PackageDefinition) {
    if (this._packageDefinition) {
      throw new Error('Package definition already set');
    }

    if (packageDefinition.name !== this.name) {
      throw new Error(`Package definition name ${packageDefinition.name} does not match package name ${this.name}`);
    }

    this._packageDefinition = packageDefinition;
  }

  get packageDirectory(): string | undefined {
    if (!this.packageDefinition?.path || !this.workingDirectory) {
      return undefined;
    }

    // In a staging/artifact context the source is always under ARTIFACT_SOURCE_DIR
    // regardless of the original project path.
    return path.join(this.workingDirectory, FORCE_APP_DIR);
  }

  get packageName(): string {
    return this._packageName;
  }

  set packageName(val: string) {
    this._packageName = val;
  }

  get type(): Omit<PackageType, 'managed'> {
    return this._packageType;
  }

  set type(val: Omit<PackageType, 'managed'>) {
    this._packageType = val;
  }

  get version(): string | undefined {
    return this._versionNumber;
  }

  set version(val: string) {
    this._versionNumber = toVersionFormat(val, 'semver');
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

  /**
   * Resolve the absolute path to the package source directory,
   * using either the working directory (staging) or project root.
   */
  public resolveSourcePackagePath(): string {
    const root = this.workingDirectory ?? this.projectDirectory;
    const pkgPath = this.packageDefinition?.path;
    if (!pkgPath) {
      throw new Error(`Package '${this.packageName}' has no path defined`);
    }

    return path.join(root, pkgPath);
  }

  public setBuildNumber(buildNumber: string): void {
    if (!buildNumber) {
      return;
    }

    const version = this.version || this.packageDefinition?.version;

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
}

export abstract class SfpmMetadataPackage extends SfpmPackage implements SourceDeployable {
  protected _componentSet?: ComponentSet;
  protected _content: SfpmPackageContent;
  private _analyzed = false;
  private _customFields?: SourceComponent[];
  private _validationState?: ValidationState;

  constructor(packageName: string, projectDirectory: string) {
    super(packageName, projectDirectory);
    this._content = {} as SfpmPackageContent;
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

  /** Content metadata populated by analyzers via updateContent(). */
  get content(): SfpmPackageContent {
    return this._content;
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

  get fhtFields(): string[] {
    return this._content?.fhtFields || [];
  }

  get flows(): SourceComponent[] {
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .filter(c => c.type.id === 'flow');
  }

  get ftFields(): string[] {
    return this._content?.ftFields || [];
  }

  get hasApex(): boolean {
    const apexTypes = new Set(['apexclass', 'apextrigger']);
    return this.getComponentSet()
    .getSourceComponents()
    .toArray()
    .some(c => apexTypes.has(c.type.id));
  }

  get hasDestructiveChanges(): boolean {
    return Boolean(this._content?.destructiveChangesPath);
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
    return (this._content?.testCoverage || 0) > TEST_COVERAGE_THRESHOLD;
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
    return this._content?.picklists || [];
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
    return this._content?.apex?.tests || [];
  }

  get testCoverage(): number | undefined {
    return this._content?.testCoverage;
  }

  set testCoverage(coverage: number) {
    this._content.testCoverage = coverage;
  }

  get testLevel(): TestLevel | undefined {
    return this.orchestration?.install?.testLevel;
  }

  set testLevel(level: TestLevel) {
    if (!this.orchestration.install) {
      this.orchestration.install = {};
    }

    this.orchestration.install.testLevel = level;
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

  get validationState(): undefined | ValidationState {
    return this._validationState;
  }

  set validationState(state: ValidationState) {
    this._validationState = state;
  }

  /** Alias for the version property, satisfying the SourceDeployable interface. */
  get versionNumber(): string | undefined {
    return this.version;
  }

  /** Returns the number of metadata components in the package. */
  public async componentCount(): Promise<number> {
    return this.getComponentSet().size;
  }

  /**
   * Run all registered content analyzers against this package.
   * Cached — safe to call multiple times (no-op after first run).
   *
   * Build path: `PackageBuilder.runAnalyzers()` runs analyzers with event
   * emission and calls `markAnalyzed()`, making this a no-op.
   *
   * Deploy/install path: call `ensureAnalyzed()` before reading
   * content that depends on analysis (testClasses, fhtFields, etc.).
   */
  public async ensureAnalyzed(): Promise<void> {
    if (this._analyzed) return;
    this._analyzed = true;

    const analyzers = AnalyzerRegistry.getAnalyzers();
    await Promise.all(analyzers.filter(a => a.isEnabled(this)).map(a => a.analyze(this)));
  }

  public getComponentSet(sourcePath?: string): ComponentSet {
    const resolvedPath = sourcePath ?? this.packageDirectory;

    if (!resolvedPath) {
      throw new Error('Package must have a working directory and a defined path');
    }

    if (!this._componentSet || sourcePath) {
      this._componentSet = ComponentSet.fromSource(resolvedPath);
    }

    return this._componentSet;
  }

  /** Returns the logical manifest of the package as a JSON-compatible object. */
  public async getManifestObject() {
    return this.getComponentSet().getObject();
  }

  /**
   * Mark the package as analyzed (prevents `ensureAnalyzed()` from re-running).
   * Called by `PackageBuilder.runAnalyzers()` after running with event emission.
   */
  public markAnalyzed(): void {
    this._analyzed = true;
  }

  /**
   * Resolves the content metadata from the component set,
   * preserving any field/apex metadata already set by analyzers.
   */
  public resolveContentMetadata(): SfpmPackageContent {
    const cs = this.getComponentSet();
    const components = cs.getSourceComponents();

    return {
      ...this._content,
      metadataCount: components.toArray().length,
      testCoverage: this.testCoverage,
    };
  }

  /** Resolves orchestration metadata from the package definition. */
  public resolveOrchestrationMetadata(): Partial<SfpmPackageOrchestration> {
    return {
      build: this.packageDefinition?.packageOptions?.build as any,
      install: this.packageDefinition?.packageOptions?.deploy,
    };
  }

  public setFhtFields(names: string[]): void {
    this.updateContent({
      fields: {
        fht: names,
      },
    } as Partial<SfpmPackageContent>);
  }

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

  public updateContent(newContent: Partial<SfpmPackageContent>): void {
    merge(this._content, newContent);
    this.enforceIntegrity();
  }

  /**
   * Ensures every name in our categorized metadata actually
   * exists as a physical component in the directory.
   */
  private enforceIntegrity(): void {
    const cs = this.getComponentSet();

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
      const currentList = get(this._content, jsonPath);

      if (!Array.isArray(currentList)) {
        continue;
      }

      const typeFullNames = knownComponents.get(metadataType.toLowerCase()) ?? new Set();
      const validated = currentList.filter(item => {
        const name = typeof item === 'string' ? item : item.name;
        return typeFullNames.has(name);
      });

      set(this._content, jsonPath, validated);
    }
  }

  /**
   * Resolves all CustomField components, including children of decomposed
   * CustomObject components. Deduplicates by fullName.
   */
  private resolveCustomFields(): SourceComponent[] {
    const sourceComponents: SourceComponent[] = this.getComponentSet().getSourceComponents().toArray();

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
}

export class SfpmDataPackage extends SfpmPackage implements DataDeployable {
  constructor(packageName: string, projectDirectory: string) {
    super(packageName, projectDirectory);
    this.type = PackageType.Data;
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

    if (this.workingDirectory) {
      return path.join(this.workingDirectory, packagePath);
    }

    return path.join(this.projectDirectory, packagePath);
  }

  /** Alias for the version property, satisfying the DataDeployable interface. */
  get versionNumber(): string | undefined {
    return this.version;
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
}

export class SfpmUnlockedPackage extends SfpmMetadataPackage implements VersionInstallable {
  /** SF packaging tag (label for the package version, set at build time) */
  public tag?: string;
  private _isOrgDependent = false;
  private _packageId?: string;
  private _packageVersionId?: string;

  constructor(packageName: string, projectDirectory: string) {
    super(packageName, projectDirectory);
    this.type = PackageType.Unlocked;
  }

  get isOrgDependent(): boolean {
    return this._isOrgDependent;
  }

  set isOrgDependent(val: boolean) {
    this._isOrgDependent = val;
  }

  get packageId(): string {
    return this._packageId || '';
  }

  set packageId(val: string) {
    this._packageId = val;
  }

  get packageVersionId(): string {
    return this._packageVersionId!;
  }

  set packageVersionId(val: string) {
    this._packageVersionId = val;
  }

  override setBuildNumber(buildNumber: string): void {}
}

/**
 * Interface for packages that support org-aliased source directories.
 */
export interface OrgAliasable {
  getAnalysisSourcePath(): string;
  readonly isOrgAliased: boolean;
  readonly orgAliasConfig: OrgAliasConfig | undefined;
  readonly orgAliasResolution: OrgAliasResolution | undefined;
  resolveOrgAlias(targetOrg?: string, logger?: Logger): Promise<OrgAliasResolution>;
}

/**
 * Type guard to check whether a package supports org aliasing.
 */
export function isOrgAliasable(pkg: SfpmPackage): pkg is OrgAliasable & SfpmPackage {
  return pkg instanceof SfpmSourcePackage && 'isOrgAliased' in pkg;
}

export class SfpmSourcePackage extends SfpmMetadataPackage implements OrgAliasable {
  private _orgAliasResolution?: OrgAliasResolution;

  get isOrgAliased(): boolean {
    return Boolean(this.packageDefinition?.packageOptions?.orgAliased);
  }

  get orgAliasConfig(): OrgAliasConfig | undefined {
    const raw = this.packageDefinition?.packageOptions?.orgAliased;
    if (!raw) return undefined;
    return typeof raw === 'object' ? raw : {};
  }

  get orgAliasResolution(): OrgAliasResolution | undefined {
    return this._orgAliasResolution;
  }

  override get packageDirectory(): string | undefined {
    if (this._orgAliasResolution?.effectivePath) {
      return this._orgAliasResolution.effectivePath;
    }

    return super.packageDirectory;
  }

  public getAnalysisSourcePath(): string {
    const basePath = this.resolveSourcePackagePath();
    if (!this.isOrgAliased) {
      return basePath;
    }

    return path.join(basePath, ORG_ALIAS_DEFAULT_DIR);
  }

  public async resolveOrgAlias(targetOrg?: string, logger?: Logger): Promise<OrgAliasResolution> {
    if (!this.isOrgAliased) {
      throw new Error(`Package '${this.packageName}' is not org-aliased`);
    }

    const packagePath = this.resolveSourcePackagePath();
    const resolver = new OrgAliasResolver(logger);
    const resolution = await resolver.resolve(
      packagePath,
      targetOrg ?? ORG_ALIAS_DEFAULT_DIR,
      this.orgAliasConfig,
    );

    this._orgAliasResolution = resolution;
    return resolution;
  }
}

/**
 * Factory for creating fully-configured SfpmPackage instances from a ProjectDefinitionProvider.
 */
export class PackageFactory {
  private provider: ProjectDefinitionProvider;

  constructor(provider: ProjectDefinitionProvider) {
    this.provider = provider;
  }

  createAll(): SfpmPackage[] {
    const packageNames = this.provider.getAllPackageNames();
    return packageNames.map(name => this.createFromName(name));
  }

  createFromName(packageName: string): SfpmPackage {
    const allPackages = this.provider.getAllPackageDefinitions();
    const packageDefinition = allPackages.find(p => p.name === packageName || stripScope(p.name) === packageName);

    if (!packageDefinition) {
      const managedRef = this.createManagedRef(packageName);
      if (managedRef) {
        throw new Error(`Package "${packageName}" is a managed dependency, not a local package. Use createManagedRef() instead.`);
      }

      throw new Error(`Package ${packageName} not found in project definition`);
    }

    const packageType = (packageDefinition.type?.toLowerCase() || 'unlocked') as PackageType;
    const projectDirectory = this.provider.projectDir;

    const sfpmPackage = this.createPackageInstance(packageType, packageName, projectDirectory);
    sfpmPackage.type = packageType;

    sfpmPackage.projectDefinition = this.provider.getProjectDefinition();
    sfpmPackage.packageDefinition = packageDefinition;
    sfpmPackage.version = packageDefinition.version;

    if (packageType === PackageType.Unlocked && sfpmPackage instanceof SfpmUnlockedPackage) {
      const {packageId} = packageDefinition;
      if (packageId) {
        sfpmPackage.packageId = packageId;
      }
    }

    return sfpmPackage;
  }

  createFromPath(packagePath: string): SfpmPackage {
    const packageDefinition = this.provider.getPackageDefinitionByPath(packagePath);
    return this.createFromName(packageDefinition.name);
  }

  createManagedRef(packageName: string): ManagedPackageRef | undefined {
    const allPackages = this.provider.getAllPackageDefinitions();
    for (const pkg of allPackages) {
      if (pkg.managedDependencies?.[packageName]) {
        return new ManagedPackageRef(packageName, pkg.managedDependencies[packageName]);
      }
    }

    return undefined;
  }

  getProvider(): ProjectDefinitionProvider {
    return this.provider;
  }

  isManagedPackage(packageName: string): boolean {
    const allPackages = this.provider.getAllPackageDefinitions();
    if (allPackages.some(p => p.name === packageName || stripScope(p.name) === packageName)) {
      return false;
    }

    return allPackages.some(p => p.managedDependencies?.[packageName] !== undefined);
  }

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
}
