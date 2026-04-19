import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('deploy:artifact', () => {
  it('runs deploy:artifact cmd', async () => {
    const {stdout} = await runCommand('deploy:artifact')
    expect(stdout).to.contain('hello world')
  })

  it('runs deploy:artifact --name oclif', async () => {
    const {stdout} = await runCommand('deploy:artifact --name oclif')
    expect(stdout).to.contain('hello oclif')
  })
})
