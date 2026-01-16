import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('project:view', () => {
  it('runs project:view cmd', async () => {
    const {stdout} = await runCommand('project:view')
    expect(stdout).to.contain('hello world')
  })

  it('runs project:view --name oclif', async () => {
    const {stdout} = await runCommand('project:view --name oclif')
    expect(stdout).to.contain('hello oclif')
  })
})
