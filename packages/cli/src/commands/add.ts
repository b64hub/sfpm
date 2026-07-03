import {Args} from '@oclif/core'
import {execSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import SfpmCommand from '../sfpm-command.js'

export default class Add extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to add',
      required: true,
    }),
  }
  static override description = 'add one or more sfpm packages as dependencies'
  static override examples = [
    '<%= config.bin %> <%= command.id %> @myorg/my-package',
    '<%= config.bin %> <%= command.id %> @myorg/package-a @myorg/package-b',
  ]
  static override strict = false

  public async execute(): Promise<void> {
    const {argv} = await this.parse(Add)
    const packages = argv as string[]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd()
    const pkgArgs = packages.map(p => `'${p}'`).join(' ')

    this.log(`Adding: ${packages.join(', ')}`)
    execSync(`pnpm add ${pkgArgs}`, {cwd: projectDir, stdio: 'inherit'})

    // Validate that added packages are sfpm packages
    const nonSfpm: string[] = []
    for (const pkg of packages) {
      const pkgJsonPath = path.join(projectDir, 'node_modules', pkg, 'package.json')
      try {
        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
          if (!pkgJson.sfpm?.packageType) {
            nonSfpm.push(pkg)
          }
        }
      } catch {
        // Skip validation if we can't read
      }
    }

    if (nonSfpm.length > 0) {
      this.warn(`Not sfpm packages (no sfpm field): ${nonSfpm.join(', ')}`)
    }
  }
}
