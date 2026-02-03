import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('install:source', () => {
  it('runs install:source cmd', async () => {
    const {stdout} = await runCommand('install:source')
    expect(stdout).to.contain('hello world')
  })

  it('runs install:source --name oclif', async () => {
    const {stdout} = await runCommand('install:source --name oclif')
    expect(stdout).to.contain('hello oclif')
  })
})
