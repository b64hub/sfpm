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
import type {
  ProjectDefinitionProvider,
  ProjectDefinitionResult,
  ResolveForPackageOptions,
} from './project-definition-provider.js';
import type {WorkspacePackageJson} from './types/workspace.js';

import {type PackageDefinition, type ProjectDefinition, ProjectDefinitionSchema} from '../../types/project.js';
import {stripScope} from '../../utils/scope-utils.js';
import {
  getAllPackageDefinitions,
  getAllPackageNames,
  getDependencies,
  getPackageDefinition,
  getPackageDefinitionByPath,
  getPackageType,
} from './project-definition-provider.js';
import {type SalesforceProjectJson, toSalesforceProjectJson} from './sfdx-project-adapter.js';
import {toPackageDefinition} from './workspace-adapter.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkspaceProviderOptions {
  logger?: Logger;
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
   * Delegates to the shared `toSalesforceProjectJson()` adapter.
   */
  static cleanForSalesforce(definition: ProjectDefinition): SalesforceProjectJson {
    return toSalesforceProjectJson(definition);
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
   * Walk up from `startDir` to find the workspace root
   * (pnpm-workspace.yaml or package.json with "workspaces" field).
   */
  static findProjectRoot(startDir: string): string | undefined {
    let dir = path.resolve(startDir);
    const {root} = path.parse(dir);

    while (dir !== root) {
      if (WorkspaceProvider.hasWorkspace(dir)) {
        return dir;
      }

      dir = path.dirname(dir);
    }

    return undefined;
  }

  /**
   * Detect whether this project has a workspace configuration
   * (pnpm-workspace.yaml or package.json workspaces field).
   */
  static hasWorkspace(projectDir: string): boolean {
    if (fs.existsSync(path.join(projectDir, 'pnpm-workspace.yaml'))
      || fs.existsSync(path.join(projectDir, 'pnpm-workspace.yml'))) {
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

  getAllPackageDefinitions(): PackageDefinition[] {
    return getAllPackageDefinitions(this.resolve().definition);
  }

  // -- Package queries ------------------------------------------------------

  getAllPackageNames(): string[] {
    return getAllPackageNames(this.resolve().definition);
  }

  getDependencies(packageName: string): PackageDefinition[] {
    return getDependencies(this.resolve().definition, packageName);
  }

  getPackageDefinition(packageName: string): PackageDefinition {
    return getPackageDefinition(this.resolve().definition, packageName);
  }

  getPackageDefinitionByPath(packagePath: string): PackageDefinition {
    return getPackageDefinitionByPath(this.resolve().definition, packagePath);
  }

  getPackageDir(packageName: string): string {
    const pkg = this.getPackageDefinition(packageName);
    const parts = pkg.path.split('/');

    // Walk up from source path to find the nearest package.json with sfpm config
    for (let i = parts.length; i > 0; i--) {
      const candidateDir = path.join(this.projectDir, ...parts.slice(0, i));
      const candidatePkg = path.join(candidateDir, 'package.json');

      try {
        if (fs.existsSync(candidatePkg)) {
          const pkgJson = JSON.parse(fs.readFileSync(candidatePkg, 'utf8'));
          if (pkgJson.sfpm?.packageType) {
            return candidateDir;
          }
        }
      } catch {
        // continue
      }
    }

    throw new Error(`No workspace package.json with sfpm config found for "${packageName}"`);
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

    // Mark first package as default
    if (packageDefinitions.length > 0) {
      packageDefinitions[0].default = true;
    }

    // 5. Build ProjectDefinition
    const projectDefinition: ProjectDefinition = {
      packages: packageDefinitions,
      sfdcLoginUrl: this.options.sfdcLoginUrl ?? 'https://login.salesforce.com',
      ...(this.options.sourceApiVersion ? {sourceApiVersion: this.options.sourceApiVersion} : {}),
      ...(this.options.sourceBehaviorOptions?.length ? {sourceBehaviorOptions: this.options.sourceBehaviorOptions} : {}),
    };

    // 6. Validate against schema
    const validated = this.validate(projectDefinition, warnings);

    // Keep sfdx-project.json in sync so @salesforce/core can load it
    WorkspaceProvider.ensureSfdxProject(this.projectDir, validated);

    this.cachedResult = {definition: validated, packages: sfpmPackages, warnings};
    return this.cachedResult;
  }

  /**
   * Resolve a single-package ProjectDefinition from the workspace package.json.
   *
   * Builds a single-package definition suitable for staging and building.
   * The returned definition is converted to sfdx-project.json format via the adapter.
   */
  resolveSingleProjectDefinition(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition {
    const result = this.resolve();
    const {definition} = result;

    // Find the target package
    const pkg = definition.packages.find(p => p.name === packageName || stripScope(p.name) === packageName);
    if (!pkg) {
      throw new Error(`Package "${packageName}" not found in workspace.`);
    }

    const singlePkg = structuredClone(pkg);

    // Mark as default
    singlePkg.default = true;

    // Strip dependencies if org-dependent
    if (options?.isOrgDependent && singlePkg.dependencies) {
      delete singlePkg.dependencies;
    }

    // Filter dependencies to only include unlocked packages
    if (singlePkg.dependencies) {
      const unlockedPackages = new Set(definition.packages
      .filter(p => p.type === 'unlocked' || !p.type)
      .map(p => p.name));
      const filteredDeps: Record<string, string> = {};
      for (const [depName, depVersion] of Object.entries(singlePkg.dependencies)) {
        if (unlockedPackages.has(depName)) {
          filteredDeps[depName] = depVersion;
        }
      }

      singlePkg.dependencies = Object.keys(filteredDeps).length > 0 ? filteredDeps : undefined;
    }

    return {
      packages: [singlePkg],
      sfdcLoginUrl: definition.sfdcLoginUrl,
      ...(definition.sourceApiVersion ? {sourceApiVersion: definition.sourceApiVersion} : {}),
      ...(definition.sourceBehaviorOptions?.length ? {sourceBehaviorOptions: definition.sourceBehaviorOptions} : {}),
    };
  }

  /**
   * Update fields on a package's package.json.
   * Supports: name, packageId, version, description.
   */
  async updatePackageConfig(packageName: string, updates: Partial<PackageDefinition>): Promise<void> {
    // Find the package entry to locate its directory
    const result = this.resolve();
    const entry = result.packages?.find(({pkgJson}) =>
      pkgJson.name === packageName || stripScope(pkgJson.name) === packageName);
    if (!entry) {
      throw new Error(`Package "${packageName}" not found in workspace.`);
    }

    const pkgJsonPath = path.join(this.options.projectDir, entry.packageDir, 'package.json');
    const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

    raw.sfpm = raw.sfpm || {};

    if (updates.name !== undefined) raw.name = updates.name;
    if (updates.version !== undefined) raw.version = updates.version;
    if (updates.description !== undefined) raw.description = updates.description;
    if (updates.packageId !== undefined) raw.sfpm.packageId = updates.packageId;
    if (updates.dependencies !== undefined) {
      raw.dependencies = {...raw.dependencies, ...updates.dependencies};
    }

    fs.writeFileSync(pkgJsonPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    this.logger?.debug(`Updated ${entry.packageDir}/package.json for package "${packageName}"`);

    // Invalidate cache so next resolve() picks up the new values
    this.cachedResult = undefined;
  }

  // =========================================================================
  // Validation
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

  // =========================================================================
  // Workspace Discovery
  // =========================================================================

  /**
   * Discover workspace member directories from pnpm-workspace.yaml or
   * root package.json workspaces field.
   */
  private discoverWorkspaceMembers(): string[] {
    const {projectDir} = this.options;

    const pnpmWorkspacePath = path.join(projectDir, 'pnpm-workspace.yaml');
    const pnpmWorkspacePathAlt = path.join(projectDir, 'pnpm-workspace.yml');
    if (fs.existsSync(pnpmWorkspacePath)) {
      return this.parsePnpmWorkspace(pnpmWorkspacePath);
    }

    if (fs.existsSync(pnpmWorkspacePathAlt)) {
      return this.parsePnpmWorkspace(pnpmWorkspacePathAlt);
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

        if (pkgJson.sfpm && typeof pkgJson.sfpm === 'object') {
          if (!pkgJson.sfpm.packageType) {
            warnings.push(`Package at ${dir} has sfpm config but no "packageType" — skipping.`);
            this.logger?.warn(`Package at ${dir} has sfpm config but no "packageType" field — skipping. Set sfpm.packageType in package.json.`);
            continue;
          }

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

  // =========================================================================
  // Package Loading
  // =========================================================================

  /**
   * Validate a ProjectDefinition against the Zod schema.
   * Logs warnings for validation issues but only throws for fatal errors.
   */
  private validate(definition: ProjectDefinition, warnings: string[]): ProjectDefinition {
    const result = ProjectDefinitionSchema.safeParse(definition);
    if (!result.success) {
      const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
      throw new Error(`Invalid project definition from workspace:\n${issues}`);
    }

    return result.data as ProjectDefinition;
  }
}
