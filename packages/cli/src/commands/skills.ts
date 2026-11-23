import {Flags} from '@oclif/core'
import fs from 'fs-extra'
import path from 'node:path'

import SfpmCommand from '../sfpm-command.js'
import {resolveCliProjectDir} from '../utils/project-dir.js'

export interface InstalledSkill {
  name: string
  path: string
  status: 'created' | 'updated'
}

export interface InstallSkillsResult {
  skills: InstalledSkill[]
  targetDir: string
}

/**
 * Copy each bundled skill directory from `sourceDir` into `targetDir`, overwriting
 * same-named skills. Anything else already in `targetDir` is left untouched.
 */
export async function installSkills(sourceDir: string, targetDir: string): Promise<InstallSkillsResult> {
  const entries = (await fs.readdir(sourceDir, {withFileTypes: true}))
  .filter(entry => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))

  await fs.ensureDir(targetDir)

  const skills = await Promise.all(entries.map(async (entry): Promise<InstalledSkill> => {
    const skillPath = path.join(targetDir, entry.name)
    const status = (await fs.pathExists(skillPath)) ? 'updated' : 'created'
    await fs.copy(path.join(sourceDir, entry.name), skillPath, {overwrite: true})
    return {name: entry.name, path: skillPath, status}
  }))

  return {skills, targetDir}
}

export default class Skills extends SfpmCommand {
  static override description = 'install sfpm agent skills into a project so coding agents can use sfpm'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dir ~/my-agent-skills',
    '<%= config.bin %> <%= command.id %> --json',
  ]
  static override flags = {
    dir: Flags.string({description: 'override the install target directory'}),
  }

  public async execute(): Promise<InstallSkillsResult> {
    const {flags} = await this.parse(Skills)

    const sourceDir = path.join(this.config.root, 'skills')
    const targetDir = flags.dir ?? path.join(resolveCliProjectDir(), '.agents', 'skills')

    const result = await installSkills(sourceDir, targetDir)

    if (this.outputMode !== 'json') {
      for (const skill of result.skills) {
        this.log(`${skill.name}: ${skill.status} (${skill.path})`)
      }

      this.log(`Review git status: skills were written to ${targetDir} (commit them if you want your team to share them).`)
    }

    return result
  }
}
