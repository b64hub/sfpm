/**
 * Artifact-based ProjectDefinitionProvider.
 *
 * Reads workspace config to enumerate which packages belong to this project,
 * then resolves PackageDefinitions from the built artifacts in node_modules.
 *
 * Used by `sfpm install` to install from published artifacts without
 * needing local source or build output. The artifact's package.json is the
 * single source of truth for version, content, packageOptions, and identity.
 *
 * Implements the same ProjectDefinitionProvider interface as WorkspaceProvider
 * so the install orchestrator, ProjectGraph, and PackageFactory work unchanged.
 */

import fs from 'node:fs';
import path from 'node:path';

import type Logger from '../../types/logger.js';
import type {PackageType} from '../../types/package.js';
import type {
  ProjectDefinitionProvider,
  ProjectDefinitionResult,
  ResolveForPackageOptions,
} from './project-definition-provider.js';

import {DIST_DIR, FORCE_APP_DIR} from '../../types/artifact.js';
import {NpmPackageJson, SfpmArtifactMetadata} from '../../types/npm.js';
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

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ArtifactProviderOptions {
  logger?: Logger;
  /**
   * Explicit package names to resolve from node_modules.
   * When provided, skips workspace discovery and uses these as the starting
   * set. Transitive sfpm dependencies are discovered by walking each
   * package's dependencies in node_modules.
   */
  packages?: string[];
  /** Absolute path to the project root directory */
  projectDir: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ArtifactProvider implements ProjectDefinitionProvider {
  public readonly projectDir: string;
  private cachedResult?: ProjectDefinitionResult;
  private readonly explicitPackages?: string[];
  private readonly logger: Logger | undefined;

  constructor(options: ArtifactProviderOptions) {
    this.projectDir = options.projectDir;
    this.logger = options.logger;
    this.explicitPackages = options.packages;
  }

  getAllPackageDefinitions(): PackageDefinition[] {
    return getAllPackageDefinitions(this.resolve().definition);
  }

  getAllPackageNames(): string[] {
    return getAllPackageNames(this.resolve().definition);
  }

  getDependencies(packageName: string): PackageDefinition[] {
    return getDependencies(this.resolve().definition, packageName);
  }

  getPackageBuildDirectory(packageName: string): string | undefined {
    return this.getPackageDir(packageName);
  }

  getPackageBuiltSourceDirectory(packageName: string): string | undefined {
    const pkgDir = this.getPackageDir(packageName);
    return pkgDir ? path.join(pkgDir, FORCE_APP_DIR) : undefined;
  }

  getPackageDefinition(packageName: string): PackageDefinition | undefined {
    // Fast path: check already-resolved definition
    const cached = getPackageDefinition(this.resolve().definition, packageName);
    if (cached) return cached;

    // Fallback: resolve from node_modules on demand
    const nodeModulesPath = path.join('node_modules', packageName);
    const pkgJsonPath = path.join(this.projectDir, nodeModulesPath, 'package.json');

    try {
      if (!fs.existsSync(pkgJsonPath)) return undefined;
      const pkgJson: NpmPackageJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (!pkgJson.sfpm?.packageType) return undefined;

      this.logger?.debug(`Resolved dependency ${packageName} from node_modules`);
      return this.toPackageDefinition(pkgJson, nodeModulesPath);
    } catch {
      return undefined;
    }
  }

  getPackageDefinitionByPath(packagePath: string): PackageDefinition {
    return getPackageDefinitionByPath(this.resolve().definition, packagePath);
  }

  getPackageDir(packageName: string): string | undefined {
    const pkg = this.getPackageDefinition(packageName);
    if (!pkg) return undefined;
    // For artifacts, the package dir is the node_modules location.
    // pkg.path is relative from project root (e.g., "node_modules/@scope/pkg/force-app").
    // Walk up from the source path to find the package root (directory containing package.json).
    const parts = pkg.path.split('/');
    for (let i = parts.length; i > 0; i--) {
      const candidateDir = path.join(this.projectDir, ...parts.slice(0, i));
      if (fs.existsSync(path.join(candidateDir, 'package.json'))) {
        return candidateDir;
      }
    }

    // Fallback: strip the sfpm source path suffix
    return path.join(this.projectDir, pkg.path);
  }

  getPackageType(packageName: string): PackageType {
    return getPackageType(this.resolve().definition, packageName);
  }

  getProjectDefinition(): ProjectDefinition {
    return this.resolve().definition;
  }

  /**
   * Resolve the project: discover sfpm packages and build a ProjectDefinition
   * from artifact metadata in node_modules.
   *
   * Two discovery modes:
   * - Explicit packages: resolves named packages from node_modules.
   *   Transitive sfpm dependencies are discovered by the ProjectGraph
   *   via the resolvePackage callback.
   * - Workspace discovery: enumerates workspace members, resolves from node_modules
   */
  resolve(): ProjectDefinitionResult {
    if (this.cachedResult) return this.cachedResult;

    const warnings: string[] = [];

    let packageNames: string[];
    if (this.explicitPackages?.length) {
      // Explicit mode: use named packages directly.
      // Transitive deps are resolved lazily by ProjectGraph via resolvePackage().
      packageNames = this.explicitPackages;
    } else {
      // Workspace mode: enumerate workspace members
      const workspaceDirs = this.discoverWorkspaceMembers();
      this.logger?.debug(`Found ${workspaceDirs.length} workspace member(s)`);
      packageNames = this.collectWorkspacePackageNames(workspaceDirs, warnings);
    }

    if (packageNames.length === 0) {
      throw new Error('No SFPM packages found. Ensure packages are installed in node_modules.');
    }

    this.logger?.debug(`Resolving ${packageNames.length} SFPM package(s): ${packageNames.join(', ')}`);

    // Resolve each package from node_modules artifact
    const packageDefinitions = this.resolveFromNodeModules(packageNames, warnings);
    if (packageDefinitions.length === 0) {
      throw new Error('No SFPM artifacts found in node_modules. Run `pnpm install` first.');
    }

    // Mark first package as default
    if (packageDefinitions.length > 0) {
      packageDefinitions[0].default = true;
    }

    // 4. Build ProjectDefinition
    const projectDefinition: ProjectDefinition = {
      packages: packageDefinitions,
    };

    // 5. Validate
    const validated = this.validate(projectDefinition, warnings);

    this.cachedResult = {definition: validated, warnings};
    return this.cachedResult;
  }

  resolveSingleProjectDefinition(packageName: string, options?: ResolveForPackageOptions): ProjectDefinition {
    const {definition} = this.resolve();
    const pkg = definition.packages.find(p => p.name === packageName || stripScope(p.name) === packageName);
    if (!pkg) {
      throw new Error(`Package "${packageName}" not found.`);
    }

    const singlePkg = structuredClone(pkg);
    singlePkg.default = true;

    if (options?.isOrgDependent && singlePkg.dependencies) {
      delete singlePkg.dependencies;
    }

    return {
      packages: [singlePkg],
      sfdcLoginUrl: definition.sfdcLoginUrl,
      ...(definition.sourceApiVersion ? {sourceApiVersion: definition.sourceApiVersion} : {}),
    };
  }

  async updatePackageConfig(_packageName: string, _updates: Partial<PackageDefinition>): Promise<void> {
    // ponytail: artifacts are immutable — nothing to update. Throw if someone tries.
    throw new Error('Cannot update package config on artifact-based provider. Artifacts are immutable.');
  }

  // =========================================================================
  // Workspace Discovery
  // =========================================================================

  private collectPackageDirs(absDir: string, relBase: string, dirs: string[], recursive: boolean): void {
    if (!fs.existsSync(absDir)) return;

    const children = fs.readdirSync(absDir, {withFileTypes: true});
    for (const child of children) {
      if (!child.isDirectory() || child.name === 'node_modules' || child.name.startsWith('.')) {
        continue;
      }

      const relPath = path.posix.join(relBase, child.name);
      const childAbs = path.join(absDir, child.name);

      if (fs.existsSync(path.join(childAbs, 'package.json'))) {
        dirs.push(relPath);
      }

      if (recursive) {
        this.collectPackageDirs(childAbs, relPath, dirs, true);
      }
    }
  }

  /**
   * Collect package names from workspace member package.json files.
   * Only includes packages that have an sfpm field (i.e., are SFPM packages).
   */
  private collectWorkspacePackageNames(workspaceDirs: string[], warnings: string[]): string[] {
    const names: string[] = [];

    for (const dir of workspaceDirs) {
      const pkgJsonPath = path.join(this.projectDir, dir, 'package.json');
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        if (pkgJson.sfpm && typeof pkgJson.sfpm === 'object' && pkgJson.name) {
          names.push(pkgJson.name);
        }
      } catch {
        this.logger?.debug(`Skipping ${dir}: unable to read package.json`);
      }
    }

    return names;
  }

  // =========================================================================
  // Node Modules Resolution
  // =========================================================================

  /**
   * Discover workspace member directories from pnpm-workspace.yaml or
   * root package.json workspaces field.
   *
   * ponytail: duplicates the discovery logic from WorkspaceProvider.
   * Extract to shared util if a third provider appears.
   */
  private discoverWorkspaceMembers(): string[] {
    const pnpmWorkspacePath = path.join(this.projectDir, 'pnpm-workspace.yaml');
    const pnpmWorkspacePathAlt = path.join(this.projectDir, 'pnpm-workspace.yml');

    if (fs.existsSync(pnpmWorkspacePath)) {
      return this.parsePnpmWorkspace(pnpmWorkspacePath);
    }

    if (fs.existsSync(pnpmWorkspacePathAlt)) {
      return this.parsePnpmWorkspace(pnpmWorkspacePathAlt);
    }

    const rootPkgPath = path.join(this.projectDir, 'package.json');
    if (fs.existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
      if (Array.isArray(rootPkg.workspaces)) {
        return this.resolveGlobs(rootPkg.workspaces);
      }
    }

    throw new Error('No workspace configuration found. Expected pnpm-workspace.yaml '
      + 'or a "workspaces" field in the root package.json.');
  }

  // =========================================================================
  // Artifact → PackageDefinition
  // =========================================================================

  /**
   * Filter a dependencies record to only include sfpm packages.
   * Checks node_modules/<dep>/package.json for the sfpm field.
   */
  private filterSfpmDependencies(dependencies: Record<string, string>): Record<string, string> {
    const sfpmDeps: Record<string, string> = {};

    for (const [depName, depVersion] of Object.entries(dependencies)) {
      const depPkgJsonPath = path.join(this.projectDir, 'node_modules', depName, 'package.json');
      try {
        if (fs.existsSync(depPkgJsonPath)) {
          const depPkgJson = JSON.parse(fs.readFileSync(depPkgJsonPath, 'utf8'));
          if (depPkgJson.sfpm?.packageType) {
            sfpmDeps[depName] = depVersion;
          }
        }
      } catch {
        // Not an sfpm package or not installed — skip
      }
    }

    return sfpmDeps;
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
        const glob = trimmed.slice(1).trim().replaceAll(/^['"]|['"]$/g, '');
        if (glob && !glob.startsWith('!')) {
          globs.push(glob);
        }
      }
    }

    return this.resolveGlobs(globs);
  }

  // =========================================================================
  // Workspace Parsing (shared with WorkspaceProvider)
  // =========================================================================

  /**
   * Resolve PackageDefinitions from node_modules for each workspace package.
   */
  private resolveFromNodeModules(packageNames: string[], warnings: string[]): PackageDefinition[] {
    const definitions: PackageDefinition[] = [];

    for (const name of packageNames) {
      const nodeModulesPath = path.join('node_modules', name);
      const pkgJsonPath = path.join(this.projectDir, nodeModulesPath, 'package.json');

      if (!fs.existsSync(pkgJsonPath)) {
        warnings.push(`Artifact for ${name} not found in node_modules. Run \`pnpm install\`.`);
        this.logger?.warn(`Artifact for ${name} not found at ${pkgJsonPath}`);
        continue;
      }

      try {
        const pkgJson: NpmPackageJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

        if (!pkgJson.sfpm?.packageType) {
          warnings.push(`${name} in node_modules has no sfpm.packageType — skipping.`);
          continue;
        }

        const definition = this.toPackageDefinition(pkgJson, nodeModulesPath);
        definitions.push(definition);
        this.logger?.debug(`Resolved ${name}@${definition.version} from node_modules`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        warnings.push(`Failed to read artifact for ${name}: ${msg}`);
        this.logger?.warn(`Failed to read artifact for ${name}: ${msg}`);
      }
    }

    return definitions;
  }

  private resolveGlobs(globs: string[]): string[] {
    const dirs: string[] = [];

    for (const glob of globs) {
      if (glob.endsWith('/*') || glob.endsWith('/**')) {
        const base = glob.replace(/\/\*\*?$/, '');
        const recursive = glob.endsWith('/**');
        this.collectPackageDirs(path.join(this.projectDir, base), base, dirs, recursive);
      } else if (fs.existsSync(path.join(this.projectDir, glob, 'package.json'))) {
        dirs.push(glob);
      }
    }

    return dirs;
  }

  /**
   * Convert an artifact's NpmPackageJson into an SFPM PackageDefinition.
   *
   * Counterpart to workspace-adapter's toPackageDefinition(), but reads
   * from a built artifact instead of a workspace package.json.
   */
  private toPackageDefinition(pkgJson: NpmPackageJson, nodeModulesPath: string): PackageDefinition {
    const sfpm = pkgJson.sfpm as SfpmArtifactMetadata;

    // Source path within the artifact (e.g., "force-app")
    // Use path.join (OS-native) so packageDirectory resolves correctly on all platforms
    const sourcePath = path.join(nodeModulesPath, sfpm.path ?? '.');

    const definition: PackageDefinition = {
      name: pkgJson.name,
      path: sourcePath,
      type: sfpm.packageType as PackageType,
      version: sfpm.versionNumber || pkgJson.version,
    };

    if (pkgJson.description) {
      definition.description = pkgJson.description;
    }

    if (sfpm.packageOptions) {
      definition.packageOptions = sfpm.packageOptions;
    }

    if (sfpm.packageId) {
      definition.packageId = sfpm.packageId;
    }

    if (sfpm.packageVersionId) {
      definition.packageVersionId = sfpm.packageVersionId;
    }

    if (sfpm.apiVersion) {
      definition.apiVersion = sfpm.apiVersion;
    }

    if (sfpm.sourceHash) {
      definition.sourceHash = sfpm.sourceHash;
    }

    // Dependencies: filter for sfpm packages in node_modules
    if (pkgJson.dependencies) {
      const sfpmDeps = this.filterSfpmDependencies(pkgJson.dependencies);
      if (Object.keys(sfpmDeps).length > 0) {
        definition.dependencies = sfpmDeps;
      }
    }

    // Managed dependencies
    if (pkgJson.managedDependencies && Object.keys(pkgJson.managedDependencies).length > 0) {
      definition.managedDependencies = {...pkgJson.managedDependencies};
    }

    return definition;
  }

  // =========================================================================
  // Validation
  // =========================================================================

  private validate(definition: ProjectDefinition, _warnings: string[]): ProjectDefinition {
    const result = ProjectDefinitionSchema.safeParse(definition);
    if (!result.success) {
      const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
      throw new Error(`Invalid project definition from artifacts:\n${issues}`);
    }

    return result.data as ProjectDefinition;
  }
}
