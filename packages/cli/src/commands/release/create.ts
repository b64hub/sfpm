import {
  readLatestPackageVersionTags, RELEASE_DIR, type ReleaseDefinition, writeReleaseDefinition,
} from '@b64hub/sfpm-core';
import {Git, WorkspaceProvider} from '@b64hub/sfpm-core';
import {
  checkbox, confirm, input, select,
} from '@inquirer/prompts';
import {Args, Flags} from '@oclif/core';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

import SfpmCommand from '../../sfpm-command.js';
import {
  getDistinctTags, isBareInvocation, resolveSelectionMode, type SelectionMode, selectPackageNames, type WorkspaceCandidate,
} from '../../types/release.js';
import {infoBox, successBox} from '../../ui/boxes.js';
import {resolvePackageInputs} from '../../utils/package-resolver.js';
import {resolveCliProjectDir} from '../../utils/project-dir.js';

export default class ReleaseCreate extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'Package names to include (scoped or unscoped)',
      required: false,
    }),
  }
  static override description = [
    'Create a release definition by resolving package versions from git tags.',
    'Run with no arguments in an interactive terminal for a guided walkthrough.',
  ].join(' ')
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
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
      description: 'Release name (used for filename). Omit along with all selection flags to launch the guided walkthrough.',
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

    // Step 3: Bare invocation (no selection/name signal at all) -> guided walkthrough
    const isBare = isBareInvocation(argv as string[], {name: flags.name, path: flags.path, tag: flags.tag});

    let releaseName: string;
    let ref: string;
    let mode: SelectionMode;

    if (isBare) {
      if (this.outputMode !== 'interactive') {
        this.error([
          'No packages specified. Provide package names, --tag, --path, and --name,',
          'or run this command in an interactive terminal for the guided walkthrough.',
        ].join(' '));
      }

      if (candidates.length === 0) {
        this.error('No workspace packages found.');
      }

      ({mode, ref, releaseName} = await this.runInteractiveWizard(candidates));
    } else {
      if (!flags.name) {
        this.error('Missing required flag name (-n, --name)');
      }

      releaseName = flags.name;
      ref = flags.ref;

      // Step 4: Resolve selection mode
      mode = resolveSelectionMode(
        argv.length > 0 ? (argv as string[]) : [],
        flags.tag?.length ? flags.tag : undefined,
        flags.path,
      );

      // Step 5: If explicit, resolve package names via resolvePackageInputs
      if (mode.kind === 'explicit') {
        try {
          const resolved = await resolvePackageInputs(mode.names, provider, {json: this.outputMode === 'json'});
          mode = {kind: 'explicit', names: resolved};
        } catch (error) {
          this.error(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // Step 6: Select packages
    const selected = selectPackageNames(candidates, mode);
    if (selected.length === 0) {
      this.error('No packages matched the selection.');
    }

    // Step 7: Read git tags
    const git = new Git(projectDir, this.sfpmLogger);
    let latest: Map<string, string>;
    try {
      latest = await readLatestPackageVersionTags(git, ref);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }

    // Step 8 & 9: Resolve versions for selected packages
    const packages: {name: string; version: string}[] = [];
    const skipped: string[] = [];

    for (const name of selected) {
      const version = latest!.get(name);
      if (!version) {
        if (mode.kind === 'explicit') {
          this.error(`No package tag found for "${name}" merged into "${ref}".`);
        } else {
          this.sfpmLogger.warn(`Skipping ${name}: no package tag merged into "${ref}"`);
          skipped.push(name);
          continue;
        }
      }

      packages.push({name, version});
    }

    // Step 10: Ensure we have at least some packages
    if (packages.length === 0) {
      this.error(`No tagged packages found for ref "${ref}".`);
    }

    // Step 11: Determine output path
    const outPath = flags.output
      ? path.resolve(flags.output)
      : path.join(projectDir, RELEASE_DIR, `${releaseName}.yaml`);

    // Step 12: Check if file exists
    if (existsSync(outPath) && !flags.force) {
      if (isBare) {
        const overwrite = await confirm({default: false, message: `${outPath} already exists. Overwrite?`});
        if (!overwrite) this.error('Aborted — release file already exists.');
      } else {
        this.error(`${outPath} already exists. Use --force to overwrite.`);
      }
    }

    // Step 13: Confirm before writing (wizard only — flag-driven invocations stay scriptable)
    if (isBare) {
      this.log(infoBox('Release Summary', {
        Packages: packages.map(p => `${p.name}@${p.version}`).join('\n'),
        Ref: ref,
        Release: releaseName,
        ...(skipped.length > 0 && {Skipped: skipped.join(', ')}),
      }));

      const proceed = await confirm({default: true, message: `Write ${outPath}?`});
      if (!proceed) this.error('Aborted.');
    }

    // Step 14: Write release definition
    const definition: ReleaseDefinition = {
      packages,
      ref,
      release: releaseName,
    };

    try {
      writeReleaseDefinition(outPath, definition);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }

    // Step 15: Return result
    const result = {
      packageCount: packages.length,
      path: outPath,
      release: releaseName,
      ...(skipped.length > 0 && {skipped}),
    };

    if (isBare) {
      this.log(successBox('Release Created', {
        File: outPath,
        Packages: String(packages.length),
      }));
    } else if (this.outputMode !== 'json') {
      this.log(`Release manifest created: ${outPath}`);
      this.log(`  Release: ${releaseName}`);
      this.log(`  Packages: ${packages.length}`);
      if (skipped.length > 0) {
        this.log(`  Skipped: ${skipped.length}`);
      }
    }

    return result;
  }

  // ====================================================================
  // Private helpers
  // ====================================================================

  /**
   * Guided, step-by-step walkthrough for `release create` when invoked with
   * no package-selection or naming signal at all. Reuses the same
   * SelectionMode/selectPackageNames engine as the flag-driven path — only
   * how the mode gets built differs.
   */
  private async runInteractiveWizard(candidates: WorkspaceCandidate[]): Promise<{mode: SelectionMode; ref: string; releaseName: string}> {
    this.log(infoBox('Release Create — Guided Walkthrough', {
      'Workspace packages': String(candidates.length),
    }));

    const strategy = await select({
      choices: [
        {name: 'All packages', value: 'all'},
        {name: 'Pick packages individually', value: 'explicit'},
        {name: 'Filter by tag', value: 'tag'},
        {name: 'Filter by workspace path', value: 'path'},
      ],
      message: 'How do you want to select packages for this release?',
    });

    let mode: SelectionMode;
    switch (strategy) {
    case 'explicit': {
      const names = await checkbox({
        choices: candidates.map(c => ({
          name: c.keywords.length > 0 ? `${c.name} (${c.keywords.join(', ')})` : c.name,
          value: c.name,
        })),
        message: 'Select packages to include:',
        required: true,
      });
      mode = {kind: 'explicit', names};

      break;
    }

    case 'path': {
      const dir = await input({
        message: 'Workspace path (packages under this directory will be included):',
        validate: (value: string) => value.trim().length > 0 || 'A path is required',
      });
      mode = {dir, kind: 'path'};

      break;
    }

    case 'tag': {
      const tags = getDistinctTags(candidates);
      if (tags.length === 0) {
        this.error('No workspace packages have any tags (package.json keywords) yet — pick a different selection strategy.');
      }

      const selectedTags = await checkbox({
        choices: tags.map(t => ({name: t, value: t})),
        message: 'Select tag(s) to include:',
        required: true,
      });
      mode = {kind: 'tag', tags: selectedTags};

      break;
    }

    default: {
      mode = {kind: 'all'};
    }
    }

    const releaseName = await input({
      message: 'Release name:',
      validate: (value: string) => value.trim().length > 0 || 'A release name is required',
    });

    const ref = await input({
      default: 'main',
      message: 'Git ref to resolve package versions from:',
    });

    return {mode, ref, releaseName};
  }
}
