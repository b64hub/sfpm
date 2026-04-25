/**
 * Workspace initializer: scaffolds a turbo-native workspace from scratch or
 * migrates an existing sfdx-project.json into workspace package.json files.
 *
 * This service generates:
 * - A `package.json` per SF package directory (with `sfpm` config)
 * - A root `package.json` (or updates existing) with workspace support
 * - A `pnpm-workspace.yaml` listing all package directories
 * - A `turbo.json` with sfpm task definitions
 *
 * When migrating, it reads the existing `sfdx-project.json` and reverses the
 * mapping: PackageDefinition → WorkspacePackageJson.
 */

import fs from 'node:fs';
import path from 'node:path';

import type {Logger} from '../types/logger.js';
import type {PackageDefinition, ProjectDefinition} from '../types/project.js';
import type {SfpmPackageConfig, WorkspacePackageJson} from '../types/workspace.js';

import {PackageType} from '../types/package.js';
import {toVersionFormat} from '../utils/version-utils.js';

// ---------------------------------------------------------------------------
// Options & Result
// ---------------------------------------------------------------------------

export interface WorkspaceInitOptions {
  /** Logger for diagnostic output */
  logger?: Logger;
  /** npm scope for package names (e.g., "@myorg") */
  npmScope: string;
  /** Package manager to configure for. Default: 'pnpm' */
  packageManager?: 'npm' | 'pnpm' | 'yarn';
  /** Absolute path to the project root */
  projectDir: string;
  /** Glob patterns for turbo.json sfpm:build inputs. If omitted, uses Turbo's $TURBO_DEFAULT$ (all git-tracked files). */
  turboInputs?: string[];
}

export interface WorkspaceInitResult {
  /** Files that were created */
  created: string[];
  /** Files that were modified (merged into) */
  modified: string[];
  /** Packages that were scaffolded */
  packages: Array<{name: string; packageDir: string; type: string}>;
  /** Warnings encountered */
  warnings: string[];
}

export interface MigrateOptions extends WorkspaceInitOptions {
  /** Workspace directory prefix for migrated packages (e.g., "packages"). Default: keep original paths. */
  workspaceDir?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WorkspaceInitializer {
  private readonly logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Migrate an existing sfdx-project.json into workspace package.json files.
   * Reads the current project config and generates package.json for each
   * package directory.
   */
  async migrate(options: MigrateOptions): Promise<WorkspaceInitResult> {
    const sfdxPath = path.join(options.projectDir, 'sfdx-project.json');
    if (!fs.existsSync(sfdxPath)) {
      throw new Error('No sfdx-project.json found. Use scaffold mode to create a fresh workspace.');
    }

    const projectDef: ProjectDefinition = JSON.parse(fs.readFileSync(sfdxPath, 'utf8'));
    const packageDirs = projectDef.packageDirectories.filter((p): p is PackageDefinition => 'package' in p && 'versionNumber' in p && typeof p.path === 'string');

    if (packageDirs.length === 0) {
      throw new Error('No package directories with package names found in sfdx-project.json.');
    }

    // First scaffold the workspace infrastructure
    const result = await this.scaffold(options);

    // Then create package.json for each SF package
    const allPackageRelPaths: string[] = [];

    for (const pkgDef of packageDirs) {
      const packageDir = this.resolvePackageDir(pkgDef, options);
      allPackageRelPaths.push(packageDir);

      const pkgJson = this.toWorkspacePackageJson(pkgDef, packageDir, options, projectDef);
      const pkgJsonPath = path.join(options.projectDir, packageDir, 'package.json');

      this.writePackageJson(pkgJsonPath, pkgJson, result);

      result.packages.push({
        name: pkgJson.name,
        packageDir,
        type: pkgJson.sfpm.packageType,
      });
    }

    // Update workspace config with actual package paths
    const pm = options.packageManager ?? 'pnpm';
    this.updateWorkspaceGlobs(options.projectDir, pm, allPackageRelPaths, result);

    return result;
  }

  /**
   * Scaffold a fresh turbo workspace. Creates minimal structure with no packages.
   * Use `migrate()` to convert an existing sfdx-project.json.
   */
  async scaffold(options: WorkspaceInitOptions): Promise<WorkspaceInitResult> {
    const result: WorkspaceInitResult = {
      created: [], modified: [], packages: [], warnings: [],
    };

    const pm = options.packageManager ?? 'pnpm';

    // 1. Root package.json
    this.scaffoldRootPackageJson(options, pm, result);

    // 2. Workspace config
    if (pm === 'pnpm') {
      this.scaffoldPnpmWorkspace(options, result);
    }

    // 3. turbo.json
    this.scaffoldTurboJson(options, result);

    // 4. .gitignore addition for sfdx-project.json (it's now generated)
    this.ensureGitignoreEntry(options.projectDir, 'sfdx-project.json', result);

    return result;
  }

  // =========================================================================
  // Scaffolding helpers
  // =========================================================================

  /**
   * Compute minimal workspace glob patterns from a list of package directories.
   * Groups packages under common parent dirs where possible.
   *
   * e.g., ["packages/core", "packages/ui", "packages/data"] → ["packages/*"]
   *       ["force-app", "data"] → ["force-app", "data"]
   */
  private computeWorkspaceGlobs(dirs: string[]): string[] {
    // Group by parent directory
    const byParent = new Map<string, string[]>();
    for (const dir of dirs) {
      const parts = dir.split('/');
      if (parts.length > 1) {
        const parent = parts.slice(0, -1).join('/');
        const existing = byParent.get(parent) ?? [];
        existing.push(dir);
        byParent.set(parent, existing);
      } else {
        // Top-level directory — can't glob
        byParent.set(dir, [dir]);
      }
    }

    const globs: string[] = [];
    for (const [parent, children] of byParent) {
      if (children.length > 1 || children[0] !== parent) {
        // Multiple children under same parent → use wildcard
        globs.push(`${parent}/*`);
      } else {
        // Single top-level dir — use exact path
        globs.push(parent);
      }
    }

    return [...new Set(globs)];
  }

  /**
   * Add an entry to .gitignore if not already present.
   */
  private ensureGitignoreEntry(
    projectDir: string,
    entry: string,
    result: WorkspaceInitResult,
  ): void {
    const gitignorePath = path.join(projectDir, '.gitignore');
    const comment = '# Generated by sfpm sync — do not edit manually';

    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (!content.includes(entry)) {
        fs.appendFileSync(gitignorePath, `\n${comment}\n${entry}\n`, 'utf8');
        result.modified.push('.gitignore');
      }
    } else {
      fs.writeFileSync(gitignorePath, `${comment}\n${entry}\n`, 'utf8');
      result.created.push('.gitignore');
    }
  }

  /**
   * Infer package type from the PackageDefinition.
   */
  private inferPackageType(pkgDef: PackageDefinition): Exclude<PackageType, 'managed'> {
    if (pkgDef.type) return pkgDef.type as Exclude<PackageType, 'managed'>;
    // Heuristic: if versionNumber has NEXT, likely unlocked
    if (pkgDef.versionNumber?.includes('NEXT')) return PackageType.Unlocked;
    return PackageType.Source;
  }

  // =========================================================================
  // Migration: PackageDefinition → WorkspacePackageJson
  // =========================================================================

  /**
   * Determine the workspace-relative package directory.
   * If a workspaceDir is specified, uses that as prefix; otherwise uses the
   * package's path directly — this guarantees uniqueness since sfdx-project.json
   * paths are by definition unique per package.
   */
  private resolvePackageDir(pkgDef: PackageDefinition, options: MigrateOptions): string {
    if (options.workspaceDir) {
      return path.posix.join(options.workspaceDir, pkgDef.package);
    }

    // Use the SF package path directly as the workspace package directory.
    // Each sfdx-project.json path is unique, so every package gets its own
    // directory and its own package.json.
    return pkgDef.path;
  }

  // =========================================================================
  // Path resolution
  // =========================================================================

  /**
   * Determine the SF source path relative to the package directory.
   * e.g., package at "packages/core" with SF path "packages/core/force-app" → "force-app"
   *       package at "src/pkg-a" with SF path "src/pkg-a" → "."
   */
  private resolveSourcePath(pkgDef: PackageDefinition, packageDir: string): string {
    const relative = path.posix.relative(packageDir, pkgDef.path);
    return relative || '.';
  }

  private scaffoldPnpmWorkspace(
    options: WorkspaceInitOptions,
    result: WorkspaceInitResult,
  ): void {
    const wsPath = path.join(options.projectDir, 'pnpm-workspace.yaml');
    if (!fs.existsSync(wsPath)) {
      fs.writeFileSync(wsPath, 'packages:\n  - \'packages/*\'\n', 'utf8');
      result.created.push('pnpm-workspace.yaml');
    }
  }

  private scaffoldRootPackageJson(
    options: WorkspaceInitOptions,
    pm: string,
    result: WorkspaceInitResult,
  ): void {
    const rootPkgPath = path.join(options.projectDir, 'package.json');
    const rootPkg: Record<string, unknown> = fs.existsSync(rootPkgPath)
      ? JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'))
      : {};

    const isNew = !fs.existsSync(rootPkgPath);

    // Set/preserve fields
    rootPkg.name ??= options.npmScope.replace('@', '') + '-project';
    rootPkg.private = true;
    rootPkg.scripts ??= {};

    const scripts = rootPkg.scripts as Record<string, string>;
    scripts['sfpm:build'] ??= 'turbo run sfpm:build';
    scripts['sfpm:deploy'] ??= 'turbo run sfpm:deploy';
    scripts['sfpm:install'] ??= 'turbo run sfpm:install';
    scripts['sfpm:sync'] ??= 'sfpm sync';

    // npm/yarn use workspaces field
    if (pm !== 'pnpm') {
      rootPkg.workspaces ??= ['packages/*'];
    }

    rootPkg.devDependencies ??= {};
    const devDeps = rootPkg.devDependencies as Record<string, string>;
    devDeps.turbo ??= 'latest';

    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf8');
    (isNew ? result.created : result.modified).push('package.json');
  }

  private scaffoldTurboJson(
    options: WorkspaceInitOptions,
    result: WorkspaceInitResult,
  ): void {
    const turboPath = path.join(options.projectDir, 'turbo.json');
    const isNew = !fs.existsSync(turboPath);

    const existing = isNew ? {} : JSON.parse(fs.readFileSync(turboPath, 'utf8'));

    const turbo = {
      $schema: 'https://turbo.build/schema.json',
      ...existing,
      globalDependencies: [
        ...new Set([
          '.forceignore',
          ...(existing.globalDependencies ?? []),
        ]),
      ],
      tasks: {
        ...existing.tasks,
        'sfpm:build': {
          cache: true,
          dependsOn: ['^sfpm:build'],
          env: ['SF_DEV_HUB', 'SFPM_FORCE_BUILD', 'SFDX_AUTH_URL', 'SF_ACCESS_TOKEN'],
          inputs: options.turboInputs ?? ['$TURBO_DEFAULT$'],
          outputs: [],
        },
        'sfpm:deploy': {
          cache: true,
          dependsOn: ['^sfpm:deploy'],
          env: ['SF_TARGET_ORG', 'SFDX_AUTH_URL', 'SF_ACCESS_TOKEN'],
          inputs: options.turboInputs ?? ['$TURBO_DEFAULT$'],
          outputs: [],
        },
        'sfpm:install': {
          cache: false,
          dependsOn: ['sfpm:build', '^sfpm:install'],
          env: ['SF_TARGET_ORG', 'SFDX_AUTH_URL', 'SF_ACCESS_TOKEN'],
        },
      },
    };

    fs.writeFileSync(turboPath, JSON.stringify(turbo, null, 2) + '\n', 'utf8');
    (isNew ? result.created : result.modified).push('turbo.json');
  }

  // =========================================================================
  // File writers
  // =========================================================================

  /**
   * Convert an SF dependency versionNumber to a pnpm workspace: range.
   *
   * SF format:     "1.2.0.LATEST" or "1.2.0.4" or undefined
   * Workspace fmt: "workspace:^1.2.0" or "workspace:*"
   *
   * Uses caret (^) range for maximum flexibility — allows any compatible version.
   * This is the key improvement over sfdx-project.json's static version pinning.
   */
  private toWorkspaceDependencyVersion(sfVersion?: string): string {
    if (!sfVersion) return 'workspace:*';

    // Convert SF version to semver, stripping build segment (LATEST/NEXT/number)
    const semver = toVersionFormat(sfVersion, 'semver', {
      includeBuildNumber: false,
      resolveTokens: true,
      strict: false,
    });

    // If conversion failed or produced empty, fall back
    if (!semver || semver === '0.0.0') return 'workspace:*';

    return `workspace:^${semver}`;
  }

  private toWorkspacePackageJson(
    pkgDef: PackageDefinition,
    packageDir: string,
    options: MigrateOptions,
    projectDef: ProjectDefinition,
  ): WorkspacePackageJson {
    const packageName = pkgDef.package;
    const sfpmPath = this.resolveSourcePath(pkgDef, packageDir);
    const packageType = this.inferPackageType(pkgDef);

    // Convert Salesforce version to semver (strip build token)
    const version = toVersionFormat(pkgDef.versionNumber, 'semver', {
      includeBuildNumber: false,
      resolveTokens: true,
      strict: false,
    });

    const sfpm: SfpmPackageConfig = {
      packageType,
      // Only set path when source lives in a subdirectory (not at package root)
      ...(sfpmPath === '.' ? {} : {path: sfpmPath}),
    };

    // Resolve packageId (0Ho) from packageAliases
    const packageAlias = projectDef.packageAliases?.[packageName];
    if (packageAlias && packageAlias.startsWith('0Ho')) {
      sfpm.packageId = packageAlias;
    }

    // Optional fields
    if ((pkgDef as any).ancestorId) sfpm.ancestorId = (pkgDef as any).ancestorId;
    if ((pkgDef as any).ancestorVersion) sfpm.ancestorVersion = (pkgDef as any).ancestorVersion;
    if ((pkgDef as any).definitionFile) sfpm.definitionFile = (pkgDef as any).definitionFile;
    if ((pkgDef as any).orgDependent) sfpm.isOrgDependent = (pkgDef as any).orgDependent;
    if (pkgDef.packageOptions) sfpm.packageOptions = pkgDef.packageOptions;

    // Resolve seedMetadata/unpackagedMetadata paths relative to package dir
    if ((pkgDef as any).seedMetadata?.path) {
      const absPath = (pkgDef as any).seedMetadata.path;
      sfpm.seedMetadata = path.posix.relative(packageDir, absPath) || absPath;
    }

    if ((pkgDef as any).unpackagedMetadata?.path) {
      const absPath = (pkgDef as any).unpackagedMetadata.path;
      sfpm.unpackagedMetadata = path.posix.relative(packageDir, absPath) || absPath;
    }

    // Build workspace dependencies from SF dependencies
    const dependencies: Record<string, string> = {};
    const managedDeps: Record<string, string> = {};

    // Collect project-internal package names so we can distinguish them from managed deps
    const projectPackageNames = new Set(projectDef.packageDirectories
    .filter((p): p is PackageDefinition => 'package' in p)
    .map(p => p.package));

    if ((pkgDef as any).dependencies) {
      for (const dep of (pkgDef as any).dependencies as Array<{package: string; versionNumber?: string}>) {
        if (projectPackageNames.has(dep.package)) {
          // Internal workspace dependency — convert SF version to semver range
          const depVersion = this.toWorkspaceDependencyVersion(dep.versionNumber);
          dependencies[`${options.npmScope}/${dep.package}`] = depVersion;
        } else {
          const versionId = projectDef.packageAliases?.[dep.package];
          if (!versionId) {
            this.logger?.warn(`Dependency "${dep.package}" of package "${packageName}" not found in packageAliases. Skipping.`);
            continue;
          }

          managedDeps[dep.package] = versionId;
        }
      }
    }

    const pkgJson: WorkspacePackageJson = {
      ...(pkgDef.versionDescription ? {description: pkgDef.versionDescription} : {}),
      ...(Object.keys(managedDeps).length > 0 ? {managedDependencies: managedDeps} : {}),
      name: `${options.npmScope}/${packageName}`,
      private: true,
      scripts: {
        'sfpm:build': `sfpm build ${packageName} --turbo`,
        'sfpm:deploy': `sfpm deploy ${packageName} --turbo`,
        'sfpm:install': `sfpm install ${packageName} --turbo`,
      },
      sfpm,
      version,
    };

    if (Object.keys(dependencies).length > 0) {
      pkgJson.dependencies = dependencies;
    }

    return pkgJson;
  }

  /**
   * Update pnpm-workspace.yaml or root package.json workspaces with actual package paths.
   */
  private updateWorkspaceGlobs(
    projectDir: string,
    pm: string,
    packageDirs: string[],
    result: WorkspaceInitResult,
  ): void {
    // Compute minimal glob patterns from package directories
    const globs = this.computeWorkspaceGlobs(packageDirs);

    if (pm === 'pnpm') {
      const wsPath = path.join(projectDir, 'pnpm-workspace.yaml');
      const content = 'packages:\n' + globs.map(g => `  - '${g}'`).join('\n') + '\n';
      fs.writeFileSync(wsPath, content, 'utf8');

      if (!result.created.includes('pnpm-workspace.yaml')) {
        result.modified.push('pnpm-workspace.yaml');
      }
    } else {
      // npm/yarn: update root package.json workspaces field
      const rootPkgPath = path.join(projectDir, 'package.json');
      if (fs.existsSync(rootPkgPath)) {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
        rootPkg.workspaces = globs;
        fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf8');
      }
    }
  }

  private writePackageJson(
    filePath: string,
    pkgJson: WorkspacePackageJson,
    result: WorkspaceInitResult,
  ): void {
    const dir = path.dirname(filePath);
    const isNew = !fs.existsSync(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, {recursive: true});
    }

    if (isNew) {
      fs.writeFileSync(filePath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
      result.created.push(path.relative(path.dirname(path.dirname(filePath)), filePath));
    } else {
      // Merge: preserve existing fields, add sfpm-specific ones
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const merged = {
        ...existing,
        ...pkgJson,
        // Preserve existing devDependencies
        devDependencies: {
          ...existing.devDependencies,
        },
        // Merge scripts (sfpm scripts added, existing preserved)
        scripts: {
          ...existing.scripts,
          ...pkgJson.scripts,
        },
      };

      // Merge dependencies (don't clobber existing non-workspace deps)
      if (pkgJson.dependencies || existing.dependencies) {
        merged.dependencies = {
          ...existing.dependencies,
          ...pkgJson.dependencies,
        };
      }

      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      result.modified.push(path.relative(path.dirname(path.dirname(filePath)), filePath));
    }
  }
}
