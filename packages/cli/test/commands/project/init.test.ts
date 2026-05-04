import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('project:init', () => {
  it('runs project init cmd', async () => {
    const {stdout} = await runCommand('project:init')
    expect(stdout).to.contain('hello world')
  })

  it('runs project init --name oclif', async () => {
    const {stdout} = await runCommand('project:init --name oclif')
    expect(stdout).to.contain('hello oclif')
  })
})
