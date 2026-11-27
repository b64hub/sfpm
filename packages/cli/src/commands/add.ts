import {Args} from '@oclif/core'
import {execSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import SfpmCommand from '../sfpm-command.js'

/** Strip a version/tag specifier (`name@1.2.3` or `@scope/name@1.2.3`) down to the bare package name. */
function parsePackageName(token: string): string {
  const start = token.startsWith('@') ? 1 : 0
  const atIndex = token.indexOf('@', start)
  return atIndex === -1 ? token : token.slice(0, atIndex)
}

/** Names of all packages in the pnpm workspace (root + members), so `add` can prefer `workspace:*` over the registry. */
function getWorkspacePackageNames(projectDir: string): Set<string> {
  try {
    const output = execSync('pnpm -r list --depth -1 --json', {cwd: projectDir, encoding: 'utf8'})
    const entries = JSON.parse(output) as Array<{name?: string}>
    const names = new Set<string>()
    for (const entry of entries) {
      if (entry.name) names.add(entry.name)
    }

    return names
  } catch {
    return new Set()
  }
}

export default class Add extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to add',
      required: true,
    }),
  }
  static override description = 'add packages as dependencies'
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
    const workspaceNames = getWorkspacePackageNames(projectDir)
    const resolvedPackages = packages.map(p => {
      const name = parsePackageName(p)
      return workspaceNames.has(name) ? `${name}@workspace:*` : p
    })
    const pkgArgs = resolvedPackages.map(p => `'${p}'`).join(' ')

    this.log(`Adding: ${resolvedPackages.join(', ')}`)
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
