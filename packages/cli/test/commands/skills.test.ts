import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {installSkills} from '../../src/commands/skills.js'

const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url))

describe('skills command', () => {
  let tmpRoot: string
  let sourceDir: string
  let targetDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sfpm-skills-'))
    sourceDir = path.join(tmpRoot, 'source')
    targetDir = path.join(tmpRoot, 'target')
    fs.mkdirSync(path.join(sourceDir, 'sfpm'), {recursive: true})
    fs.writeFileSync(path.join(sourceDir, 'sfpm', 'SKILL.md'), '---\nname: sfpm\ndescription: test\n---\n')
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, {force: true, recursive: true})
  })

  it('creates the sfpm skill in an empty target directory', async () => {
    const result = await installSkills(sourceDir, targetDir)

    expect(result.targetDir).to.equal(targetDir)
    expect(result.skills).to.deep.equal([
      {name: 'sfpm', path: path.join(targetDir, 'sfpm'), status: 'created'},
    ])
    expect(fs.readFileSync(path.join(targetDir, 'sfpm', 'SKILL.md'), 'utf8')).to.equal(fs.readFileSync(path.join(sourceDir, 'sfpm', 'SKILL.md'), 'utf8'))
  })

  it('reports updated on rerun and leaves unrelated target files alone', async () => {
    await installSkills(sourceDir, targetDir)

    fs.mkdirSync(path.join(targetDir, 'other-stuff'))
    fs.writeFileSync(path.join(targetDir, 'other-stuff', 'file.txt'), 'keep me')
    fs.writeFileSync(path.join(targetDir, 'sfpm', 'SKILL.md'), 'stale content')

    const result = await installSkills(sourceDir, targetDir)

    expect(result.skills).to.deep.equal([
      {name: 'sfpm', path: path.join(targetDir, 'sfpm'), status: 'updated'},
    ])
    expect(fs.readFileSync(path.join(targetDir, 'sfpm', 'SKILL.md'), 'utf8')).to.equal(fs.readFileSync(path.join(sourceDir, 'sfpm', 'SKILL.md'), 'utf8'))
    expect(fs.readFileSync(path.join(targetDir, 'other-stuff', 'file.txt'), 'utf8')).to.equal('keep me')
  })

  describe('bundled skills', () => {
    const skillDirs = fs.readdirSync(BUNDLED_SKILLS_DIR, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)

    it('bundles at least one skill', () => {
      expect(skillDirs).to.not.be.empty
    })

    for (const dir of skillDirs) {
      it(`${dir}/SKILL.md has frontmatter with name matching its directory and a description`, () => {
        const content = fs.readFileSync(path.join(BUNDLED_SKILLS_DIR, dir, 'SKILL.md'), 'utf8')
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1]
        expect(frontmatter, 'missing YAML frontmatter').to.be.a('string')

        const name = /^name:\s*(.+)$/m.exec(frontmatter!)?.[1].trim()
        const description = /^description:\s*(.+)$/m.exec(frontmatter!)?.[1].trim()
        expect(name, 'frontmatter name').to.equal(dir)
        expect(description, 'frontmatter description').to.be.a('string').and.not.be.empty
      })
    }
  })
})
