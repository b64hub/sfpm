/**
 * Workspace-based ProjectDefinitionProvider.
 *
 * Reads workspace package.json files (pnpm/npm/yarn) with `sfpm` config
 * and assembles a ProjectDefinition. This is the package.json-first
 * alternative to reading sfdx-project.json.
 *
 * Implements the ProjectDefinitionProvider interface so it can be plugged
 * into ProjectService alongside the legacy SfdxProjectProvider.
 */

import fs from 'node:fs';
import path from 'node:path';

import type {Logger} from '../../types/logger.js';
import type {PackageType} from '../../types/package.js';
import type {ManagedPackageDefinition, PackageDefinition, ProjectDefinition} from '../../types/project.js';
import type {WorkspacePackageJson} from '../../types/workspace.js';
import type {
  ClassifiedDependencies,
  PackageDependency,
  ProjectDefinitionProvider,
  ProjectDefinitionResult,
  ResolveForPackageOptions,
} from './project-definition-provider.js';

import {
  collectPackageAliases,
  stripScope,
  toPackageDefinition,
} from '../package-json-adapter.js';
import {
  classifyDependencies,
  getAllPackageDefinitions,
  getAllPackageNames,
  getDependencies,
  getManagedPackages,
  getPackageDefinition,
  getPackageDefinitionByPath,
  getPackageId,
  getPackageType,
} from './project-definition-provider.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkspaceProviderOptions {
  logger?: Logger;
  /** Salesforce namespace (empty string for no namespace) */
  namespace?: string;
  /** Absolute path to the project root directory */
  projectDir: string;
  /** Salesforce login URL */
  sfdcLoginUrl?: string;
  /** Source API version for sfdx-project.json (e.g., "63.0") */
  sourceApiVersion?: string;
  /** Source behavior options written to sfdx-project.json */
  sourceBehaviorOptions?: string[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class WorkspaceProvider implements ProjectDefinitionProvider {
  public readonly projectDir: string;
  private cachedResult?: ProjectDefinitionResult;
  private readonly logger: Logger | undefined;
  private readonly options: WorkspaceProviderOptions;

  constructor(options: WorkspaceProviderOptions) {
    this.options = options;
    this.projectDir = options.projectDir;
    this.logger = options.logger;
  }

  /**
   * Remove SFPM-specific fields that Salesforce CLI doesn't understand.
   */
  static cleanForSalesforce(definition: ProjectDefinition): Record<string, unknown> {
    const cleaned = structuredClone(definition) as any;

    if (Array.isArray(cleaned.packageDirectories)) {
      cleaned.packageDirectories = cleaned.packageDirectories.map((pkgDir: any) => {
        const {npmName: _npm, packageOptions: _, type: _type, ...rest} = pkgDir;
        return rest;
      });
    }

    return cleaned;
  }

  /**
   * Write sfdx-project.json so that @salesforce/core's SfProject can load it.
   * Always writes to keep in sync with workspace package.json files.
   */
  static ensureSfdxProject(projectDir: string, definition: ProjectDefinition): void {
    const sfdxPath = path.join(projectDir, 'sfdx-project.json');
    const cleaned = WorkspaceProvider.cleanForSalesforce(definition);
    fs.writeFileSync(sfdxPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
  }

  /**
   * Detect whether this project has a workspace configuration
   * (pnpm-workspace.yaml or package.json workspaces field).
   */
  static hasWorkspace(projectDir: string): boolean {
    if (fs.existsSync(path.join(projectDir, 'pnpm-workspace.yaml'))) {
      return true;
    }

    const rootPkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(rootPkgPath)) {
      try {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
        return Array.isArray(rootPkg.workspaces);
      } catch {
        return false;
      }
    }

    return false;
  }

  classifyDependencies(packageName: string): ClassifiedDependencies {
    return classifyDependencies(this.resolve().definition, packageName);
  }

  getAllPackageDefinitions(): PackageDefinition[] {
    return getAllPackageDefinitions(this.resolve().definition);
  }

  // -- Package queries ------------------------------------------------------

  getAllPackageNames(): string[] {
    return getAllPackageNames(this.resolve().definition);
  }

  getDependencies(packageName: string): PackageDependency[] {
    return getDependencies(this.resolve().definition, packageName);
  }

  getManagedPackages(): ManagedPackageDefinition[] {
    return getManagedPackages(this.resolve().definition);
  }

  getPackageDefinition(packageName: string): PackageDefinition {
    return getPackageDefinition(this.resolve().definition, packageName);
  }

  getPackageDefinitionByPath(packagePath: string): PackageDefinition {
    return getPackageDefinitionByPath(this.resolve().definition, packagePath);
  }

  getPackageId(packageAlias: string): string | undefined {
    return getPackageId(this.resolve().definition, packageAlias);
  }

  getPackageType(packageName: string): PackageType {
    return getPackageType(this.resolve().definition, packageName);
  }

  // -- Dependency queries ---------------------------------------------------

  getProjectDefinition(): ProjectDefinition {
    return this.resolve().definition;
  }

  /**
   * Resolve the workspace: discover packages, build a ProjectDefinition.
   */
  resolve(): ProjectDefinitionResult {
    if (this.cachedResult) return this.cachedResult;

    const warnings: string[] = [];

    // 1. Discover workspace member directories
    const workspaceDirs = this.discoverWorkspaceMembers();
    this.logger?.debug(`Found ${workspaceDirs.length} workspace member(s)`);

    // 2. Load and filter package.json files with sfpm config
    const sfpmPackages = this.loadSfpmPackages(workspaceDirs, warnings);
    if (sfpmPackages.length === 0) {
      throw new Error('No workspace packages with an "sfpm" field found. '
        + 'Each SF package directory needs a package.json with an "sfpm" configuration block.');
    }

    this.logger?.debug(`Found ${sfpmPackages.length} SFPM package(s): ${sfpmPackages.map(p => p.pkgJson.name).join(', ')}`);

    // 3. Build workspace version map for dependency resolution
    const workspaceVersions = new Map<string, string>();
    for (const {pkgJson} of sfpmPackages) {
      workspaceVersions.set(pkgJson.name, pkgJson.version);
    }

    // 4. Convert to PackageDefinitions
    const packageDefinitions = sfpmPackages.map(({packageDir, pkgJson}) =>
      toPackageDefinition(pkgJson, packageDir, workspaceVersions));

    if (packageDefinitions.length > 0) {
      (packageDefinitions[0] as any).default = true;
    }

    // 5. Collect packageAliases
    const packageAliases = collectPackageAliases(sfpmPackages.map(p => p.pkgJson));

    for (const {pkgJson} of sfpmPackages) {
      const packageName = stripScope(pkgJson.name);
      if (pkgJson.sfpm.packageId && !packageAliases[packageName]) {
        packageAliases[packageName] = pkgJson.sfpm.packageId;
      }
    }

    // 6. Build ProjectDefinition
    const projectDefinition: ProjectDefinition = {
      namespace: this.options.namespace ?? '',
      packageAliases: Object.keys(packageAliases).length > 0 ? packageAliases : undefined,
      packageDirectories: packageDefinitions,
      sfdcLoginUrl: this.options.sfdcLoginUrl ?? 'https://login.salesforce.com',
      ...(this.options.sourceApiVersion ? {sourceApiVersion: this.options.sourceApiVersion} : {}),
      ...(this.options.sourceBehaviorOptions?.length ? {sourceBehaviorOptions: this.options.sourceBehaviorOptions} : {}),
    } as ProjectDefinition;

    this.cachedResult = {definition: projectDefinition, packages: sfpmPackages, warnings};
    return this.cachedResult;
  }

  /**
   * Resolve a single-package ProjectDefinition from the workspace package.json.
   *
   * Builds the definition from the target package's own package.json, including
   * project-level settings (namespace, sourceApiVersion, sfdcLoginUrl) and relevant
   * packageAliases (own 0Ho ID, managed deps, dependency 0Ho IDs).
   */
  resolveForPackage(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition {
    const result = this.resolve();
    const {packages} = result;

    if (!packages) {
      throw new Error('No workspace packages available');
    }

    // Find the target package by SF name (scope-stripped)
    const entry = packages.find(({pkgJson}) => stripScope(pkgJson.name) === packageName);
    if (!entry) {
      throw new Error(`Package "${packageName}" not found in workspace.`);
    }

    const {packageDir, pkgJson} = entry;

    // Build workspace version map for dependency version resolution
    const workspaceVersions = new Map<string, string>();
    for (const {pkgJson: p} of packages) {
      workspaceVersions.set(p.name, p.version);
    }

    const definition = toPackageDefinition(pkgJson, packageDir, workspaceVersions) as PackageDefinition;
    definition.default = true;

    // Strip SFPM-specific fields that Salesforce CLI doesn't understand
    delete (definition as any).npmName;
    delete (definition as any).type;

    if (options?.isOrgDependent && definition.dependencies) {
      delete (definition as any).dependencies;
    }

    // Build packageAliases relevant to this package
    const aliases: Record<string, string> = {};

    // Own 0Ho ID
    if (pkgJson.sfpm.packageId) {
      aliases[packageName] = pkgJson.sfpm.packageId;
    }

    // Managed dependency aliases
    if (pkgJson.managedDependencies) {
      for (const [alias, versionId] of Object.entries(pkgJson.managedDependencies)) {
        aliases[alias] = versionId;
      }
    }

    // Dependency 0Ho IDs from other workspace packages
    if (definition.dependencies) {
      const fullAliases = result.definition.packageAliases ?? {};
      for (const dep of definition.dependencies as Array<{package: string}>) {
        const alias = fullAliases[dep.package];
        if (alias && !aliases[dep.package]) {
          aliases[dep.package] = alias as string;
        }
      }
    }

    return {
      namespace: this.options.namespace ?? '',
      packageAliases: Object.keys(aliases).length > 0 ? aliases : undefined,
      packageDirectories: [definition],
      sfdcLoginUrl: this.options.sfdcLoginUrl ?? 'https://login.salesforce.com',
      ...(this.options.sourceApiVersion ? {sourceApiVersion: this.options.sourceApiVersion} : {}),
      ...(this.options.sourceBehaviorOptions?.length ? {sourceBehaviorOptions: this.options.sourceBehaviorOptions} : {}),
    } as ProjectDefinition;
  }

  // =========================================================================
  // Workspace Discovery
  // =========================================================================

  /**
   * Collect directories containing package.json, optionally recursing into subdirectories.
   */
  private collectPackageDirs(absDir: string, relBase: string, dirs: string[], recursive: boolean): void {
    if (!fs.existsSync(absDir)) return;

    const children = fs.readdirSync(absDir, {withFileTypes: true});
    for (const child of children) {
      if (!child.isDirectory() || child.name === 'node_modules' || child.name.startsWith('.')) {
        continue;
      }

      const relPath = path.posix.join(relBase, child.name);
      const childAbs = path.join(absDir, child.name);
      const pkgJsonPath = path.join(childAbs, 'package.json');

      if (fs.existsSync(pkgJsonPath)) {
        dirs.push(relPath);
      }

      if (recursive) {
        this.collectPackageDirs(childAbs, relPath, dirs, true);
      }
    }
  }

  /**
   * Discover workspace member directories from pnpm-workspace.yaml or
   * root package.json workspaces field.
   */
  private discoverWorkspaceMembers(): string[] {
    const {projectDir} = this.options;

    const pnpmWorkspacePath = path.join(projectDir, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmWorkspacePath)) {
      return this.parsePnpmWorkspace(pnpmWorkspacePath);
    }

    const rootPkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
      if (Array.isArray(rootPkg.workspaces)) {
        return this.resolveGlobs(rootPkg.workspaces);
      }
    }

    throw new Error('No workspace configuration found. Expected pnpm-workspace.yaml '
      + 'or a "workspaces" field in the root package.json.');
  }

  private loadSfpmPackages(
    workspaceDirs: string[],
    warnings: string[],
  ): Array<{packageDir: string; pkgJson: WorkspacePackageJson}> {
    const packages: Array<{packageDir: string; pkgJson: WorkspacePackageJson}> = [];

    for (const dir of workspaceDirs) {
      const pkgJsonPath = path.join(this.options.projectDir, dir, 'package.json');

      try {
        const content = fs.readFileSync(pkgJsonPath, 'utf8');
        const pkgJson = JSON.parse(content);

        if (pkgJson.sfpm && typeof pkgJson.sfpm === 'object' && pkgJson.sfpm.packageType) {
          if (!pkgJson.name) {
            warnings.push(`Package at ${dir} has sfpm config but no "name" field — skipping.`);
            continue;
          }

          if (!pkgJson.version) {
            warnings.push(`Package at ${dir} has sfpm config but no "version" field — skipping.`);
            continue;
          }

          packages.push({packageDir: dir, pkgJson: pkgJson as WorkspacePackageJson});
        }
      } catch {
        this.logger?.debug(`Skipping ${dir}: unable to read package.json`);
      }
    }

    return packages;
  }

  private parsePnpmWorkspace(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const globs: string[] = [];
    let inPackages = false;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      if (trimmed === 'packages:') {
        inPackages = true;
        continue;
      }

      if (inPackages && trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('#')) {
        break;
      }

      if (inPackages && trimmed.startsWith('-')) {
        const glob = trimmed
        .slice(1)
        .trim()
        .replaceAll(/^['"]|['"]$/g, '');

        if (glob && !glob.startsWith('!')) {
          globs.push(glob);
        }
      }
    }

    return this.resolveGlobs(globs);
  }

  // =========================================================================
  // Package Loading
  // =========================================================================

  private resolveGlobs(globs: string[]): string[] {
    const {projectDir} = this.options;
    const dirs: string[] = [];

    for (const glob of globs) {
      if (glob.endsWith('/*') || glob.endsWith('/**')) {
        // Wildcard: list child directories (recursively for /**)
        const base = glob.replace(/\/\*\*?$/, '');
        const recursive = glob.endsWith('/**');
        this.collectPackageDirs(path.join(projectDir, base), base, dirs, recursive);
      } else {
        const pkgJsonPath = path.join(projectDir, glob, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          dirs.push(glob);
        }
      }
    }

    return dirs;
  }
}
