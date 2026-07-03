import {ProjectService} from '@b64hub/sfpm-core'
import {Args, Flags} from '@oclif/core'
import {execSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import SfpmCommand from '../sfpm-command.js'

export default class Publish extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to publish (defaults to all workspace packages)',
      required: false,
    }),
  }
  static override description = 'publish one or more packages from their dist directories'
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package',
    '<%= config.bin %> <%= command.id %> my-package --tag next',
    '<%= config.bin %> <%= command.id %> all',
  ]
  static override flags = {
    'dry-run': Flags.boolean({description: 'show what would be published without actually publishing'}),
    tag: Flags.string({default: 'latest', description: 'npm dist-tag (e.g., latest, next)'}),
  }
  static override strict = false

  public async execute(): Promise<void> {
    const {argv, flags} = await this.parse(Publish)
    const packages = argv as string[]

    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd()
    const projectService = await ProjectService.getInstance(projectDir)
    const provider = projectService.getDefinitionProvider()

    // No args or "all" → publish every workspace package
    const packageNames = (!packages || packages.length === 0 || packages.includes('all'))
      ? provider.getAllPackageNames()
      : packages

    for (const name of packageNames) {
      const packageDir = provider.getPackageDir(name)
      const distDir = path.join(packageDir, 'dist')

      if (!fs.existsSync(path.join(distDir, 'package.json'))) {
        this.warn(`No build found for ${name} — run 'sfpm build' first. Skipping.`)
        continue
      }

      const tagArg = flags.tag ? `--tag ${flags.tag}` : ''
      const dryArg = flags['dry-run'] ? '--dry-run' : ''
      const cmd = `pnpm publish --no-git-checks ${tagArg} ${dryArg}`.trim()

      this.log(`Publishing ${name} from ${distDir}`)
      try {
        execSync(cmd, {cwd: distDir, stdio: 'inherit'})
      } catch {
        this.error(`Failed to publish ${name}`, {exit: 1})
      }
    }
  }
}
