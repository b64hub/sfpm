import {expect} from 'chai';

import type {PackageRowProps, RowStep} from '../../src/ui/components/PackageRow.js';

import {PackageRow} from '../../src/ui/components/PackageRow.js';

// PackageRow is a plain function component (Object.assign(PackageRowFn, {...})),
// so calling it directly returns the unrendered React element tree — no
// renderer/DOM needed to inspect which branch of a conditional rendered.

const STEPS: RowStep[] = [
  {icon: '✔', id: 's1', isLast: false, primary: 'connect'},
  {icon: '●', id: 's2', isLast: true,  primary: 'deploy'},
];

function baseProps(overrides: Partial<PackageRowProps> = {}): PackageRowProps {
  return {
    expanded: true,
    icon: '✖',
    id: 'pkg:cvc',
    primary: 'cvc',
    steps: STEPS,
    ...overrides,
  };
}

/** Outer <Box flexDirection="column"> children: [headerRow, stepsSlot]. */
function stepsSlotOf(props: PackageRowProps): unknown {
  const element = PackageRow({props}) as any;
  return element.props.children[1];
}

/** Header row's left-side <Box> children: [icon, <Text>primary</Text>, error ?? secondary]. */
function detailSlotOf(props: PackageRowProps): unknown {
  const element = PackageRow({props}) as any;
  const [headerRow] = element.props.children;
  const [leftSide] = headerRow.props.children;
  return leftSide.props.children[2];
}

describe('ui: PackageRow', () => {
  it('renders step children when no error is set and expanded is true', () => {
    const slot = stepsSlotOf(baseProps());
    expect(slot).to.be.an('array').with.length(2);
  });

  it('suppresses step children when error is set, even if expanded and steps are present', () => {
    const slot = stepsSlotOf(baseProps({error: 'Source deployment failed'}));
    expect(slot).to.equal(false);
  });

  it('shows error content in place of secondary when both are set', () => {
    const slot = detailSlotOf(baseProps({error: 'boom', secondary: 'should not show'}));
    expect(slot).to.equal('boom');
  });

  it('falls back to secondary when error is not set', () => {
    const slot = detailSlotOf(baseProps({secondary: 'hint'}));
    expect(slot).to.equal('hint');
  });
});
