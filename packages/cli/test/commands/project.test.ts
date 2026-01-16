import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('project', () => {
  it('runs project cmd', async () => {
    const {stdout} = await runCommand('project')
    expect(stdout).to.contain('hello world')
  })

  it('runs project --name oclif', async () => {
    const {stdout} = await runCommand('project --name oclif')
    expect(stdout).to.contain('hello oclif')
  })
})
