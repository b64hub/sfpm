import {expect} from 'chai'

import Build from '../../src/commands/build/index.js'

// Regression test for https://github.com/b64hub/sfpm/issues/90
//
// `validation` is a plain string flag, so oclif's `--no-<flag>` negation
// (which only applies to boolean flags) never actually matched it — passing
// `--no-validation` threw "Unexpected flag --no-validation" instead of
// selecting 'none'. Fix: make 'none' a selectable `--validation` value and
// stop advertising the broken `--no-validation` shorthand.
describe('build --validation flag', () => {
  it('accepts "none" as a selectable validation level', () => {
    expect(Build.flags.validation.options).to.include('none')
  })

  it('does not claim boolean --no-validation negation support', () => {
    expect(Build.flags.validation.allowNo).to.not.equal(true)
  })
})
