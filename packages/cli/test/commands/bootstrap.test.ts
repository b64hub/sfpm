import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('bootstrap', () => {
  it('requires --target-org flag', async () => {
    const {error} = await runCommand('bootstrap')
    expect(error?.message).to.contain('Missing required flag')
  })

  it('rejects invalid --tier values', async () => {
    const {error} = await runCommand('bootstrap -o test-org --tier invalid')
    expect(error?.message).to.contain('Expected --tier=invalid to be one of')
  })
})
