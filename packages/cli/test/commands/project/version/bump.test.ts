import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('project:version:bump', () => {
  it('runs project:version:bump cmd', async () => {
    const {stdout} = await runCommand('project:version:bump')
    expect(stdout).to.contain('hello world')
  })

  it('runs project:version:bump --name oclif', async () => {
    const {stdout} = await runCommand('project:version:bump --name oclif')
    expect(stdout).to.contain('hello oclif')
  })
})
