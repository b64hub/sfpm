import {expect} from 'chai'

import PoolFetch from '../../src/commands/pool/fetch.js'

// Every --flag shown in a command's examples must be a real flag of that command (issue #82).
// Scoped to pool fetch: importing every command under ts-node exits the mocha process silently.
describe('command examples', () => {
  it('every --flag used in command examples is defined', () => {
    const valid = new Set<string>()
    for (const [name, flag] of Object.entries({...PoolFetch.baseFlags, ...PoolFetch.flags}) as Array<[string, {allowNo?: boolean}]>) {
      valid.add(name)
      if (flag.allowNo) valid.add(`no-${name}`)
    }

    const unknown: string[] = []
    for (const example of PoolFetch.examples as Array<string | {command: string}>) {
      const text = typeof example === 'string' ? example : example.command
      for (const match of text.matchAll(/(?:^|\s)--([a-z][a-z0-9-]*)/g)) {
        if (!valid.has(match[1])) unknown.push(`pool/fetch.ts: --${match[1]}`)
      }
    }

    expect(unknown).to.deep.equal([])
  })

  it('pool fetch no longer defines the dead --limit flag', () => {
    expect(PoolFetch.flags).to.not.have.property('limit')
  })
})
