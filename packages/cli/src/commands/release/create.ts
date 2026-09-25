import {
  readLatestPackageVersionTags, RELEASE_DIR, type ReleaseDefinition, writeReleaseDefinition,
} from '@b64hub/sfpm-core';
import {Git, WorkspaceProvider} from '@b64hub/sfpm-core';
import {Args, Flags} from '@oclif/core';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

import SfpmCommand from '../../sfpm-command.js';
import {resolveSelectionMode, selectPackageNames, type WorkspaceCandidate} from '../../types/release.js';
import {resolvePackageInputs} from '../../utils/package-resolver.js';
import {resolveCliProjectDir} from '../../utils/project-dir.js';

export default class ReleaseCreate extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'Package names to include (scoped or unscoped)',
      required: false,
    }),
  }
  static override description = 'Create a release definition by resolving package versions from git tags'
  static override examples = [
    '<%= config.bin %> <%= command.id %> -n summer-2025 pkg-a pkg-b',
    '<%= config.bin %> <%= command.id %> -n summer-2025 --tag core,sales',
    '<%= config.bin %> <%= command.id %> -n summer-2025 --path packages/core',
    '<%= config.bin %> <%= command.id %> -n summer-2025',
  ]
  static override flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Overwrite existing release file',
    }),
    name: Flags.string({
      char: 'n',
      description: 'Release name (used for filename)',
      required: true,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output file path (overrides default release/<name>.yaml)',
    }),
    path: Flags.string({
      char: 'p',
      description: 'Include only packages in this directory (and descendants)',
    }),
    ref: Flags.string({
      char: 'r',
      default: 'main',
      description: 'Git ref to resolve package versions from',
    }),
    tag: Flags.string({
      char: 't',
      description: 'Include packages carrying this tag — an sfpm package tag stored in package.json keywords (repeatable, comma-separated)',
      multiple: true,
    }),
  }
  static override strict = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any,complexity
  public async execute(): Promise<any> {
    const {argv, flags} = await this.parse(ReleaseCreate);

    const projectDir = resolveCliProjectDir();

    // Step 1: Load workspace packages
    const provider = new WorkspaceProvider({logger: this.sfpmLogger, projectDir});

    // Step 2: Build candidates with keywords
    const candidates: WorkspaceCandidate[] = [];
    for (const name of provider.getAllPackageNames()) {
      const pkgDir = provider.getPackageDir(name);
      if (!pkgDir) continue;

      let keywords: string[] = [];
      try {
        const pkgJsonPath = path.join(pkgDir, 'package.json');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pkgJson: any = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        if (Array.isArray(pkgJson.keywords)) {
          keywords = pkgJson.keywords;
        }
      } catch (error) {
        // If we can't read keywords, just use empty array
        this.sfpmLogger.debug(`Could not read keywords for ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }

      candidates.push({dir: pkgDir, keywords, name});
    }

    // Step 3: Resolve selection mode
    let mode = resolveSelectionMode(
      argv.length > 0 ? (argv as string[]) : [],
      flags.tag?.length ? flags.tag : undefined,
      flags.path,
    );

    // Step 4: If explicit, resolve package names via resolvePackageInputs
    if (mode.kind === 'explicit') {
      try {
        const resolved = await resolvePackageInputs(mode.names, provider, {json: this.outputMode === 'json'});
        mode = {kind: 'explicit', names: resolved};
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
    }

    // Step 5: Select packages
    const selected = selectPackageNames(candidates, mode);
    if (selected.length === 0) {
      this.error('No packages matched the selection.');
    }

    // Step 6: Read git tags
    const git = new Git(projectDir, this.sfpmLogger);
    let latest: Map<string, string>;
    try {
      latest = await readLatestPackageVersionTags(git, flags.ref);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }

    // Step 7 & 8: Resolve versions for selected packages
    const packages: {name: string; version: string}[] = [];
    const skipped: string[] = [];

    for (const name of selected) {
      const version = latest!.get(name);
      if (!version) {
        if (mode.kind === 'explicit') {
          this.error(`No package tag found for "${name}" merged into "${flags.ref}".`);
        } else {
          this.sfpmLogger.warn(`Skipping ${name}: no package tag merged into "${flags.ref}"`);
          skipped.push(name);
          continue;
        }
      }

      packages.push({name, version});
    }

    // Step 9: Ensure we have at least some packages
    if (packages.length === 0) {
      this.error(`No tagged packages found for ref "${flags.ref}".`);
    }

    // Step 10: Determine output path
    const outPath = flags.output
      ? path.resolve(flags.output)
      : path.join(projectDir, RELEASE_DIR, `${flags.name}.yaml`);

    // Step 11: Check if file exists
    if (existsSync(outPath) && !flags.force) {
      this.error(`${outPath} already exists. Use --force to overwrite.`);
    }

    // Step 12: Write release definition
    const definition: ReleaseDefinition = {
      packages,
      ref: flags.ref,
      release: flags.name,
    };

    try {
      writeReleaseDefinition(outPath, definition);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }

    // Step 13: Return result
    const result = {
      packageCount: packages.length,
      path: outPath,
      release: flags.name,
      ...(skipped.length > 0 && {skipped}),
    };

    if (this.outputMode !== 'json') {
      this.log(`Release manifest created: ${outPath}`);
      this.log(`  Release: ${flags.name}`);
      this.log(`  Packages: ${packages.length}`);
      if (skipped.length > 0) {
        this.log(`  Skipped: ${skipped.length}`);
      }
    }

    return result;
  }
}
