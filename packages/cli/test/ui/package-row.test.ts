import {expect} from 'chai';

import type {PackageRowProps, RowStep} from '../../src/ui/components/PackageRow.js';

import {ErrorLines, PackageRow} from '../../src/ui/components/PackageRow.js';

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

/** Outer <Box> children: [headerRow, stepsSlot, errorLinesSlot]. */
function errorLinesSlotOf(props: PackageRowProps): unknown {
  const element = PackageRow({props}) as any;
  return element.props.children[2];
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

  it('renders no errorLines slot when errorLines is absent', () => {
    const slot = errorLinesSlotOf(baseProps());
    expect(slot).to.not.be.ok;
  });

  it('renders no errorLines slot when errorLines is empty', () => {
    const slot = errorLinesSlotOf(baseProps({errorLines: []}));
    expect(slot).to.not.be.ok;
  });

  it('renders an ErrorLines element carrying the full (uncapped) list', () => {
    const lines = ['a', 'b', 'c'];
    const slot = errorLinesSlotOf(baseProps({errorLines: lines})) as any;
    expect(slot.type).to.equal(ErrorLines);
    expect(slot.props.lines).to.equal(lines);
  });
});

describe('ui: PackageRow.ErrorLines', () => {
  it('shows every line when at or under the cap', () => {
    const element = ErrorLines({lines: ['a', 'b']}) as any;
    const [textLines, trailer] = element.props.children;
    expect(textLines).to.have.length(2);
    expect(trailer).to.equal(false);
  });

  it('caps at 5 lines and shows a "+N more" trailer beyond that', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const element = ErrorLines({lines}) as any;
    const [textLines, trailer] = element.props.children;
    expect(textLines).to.have.length(5);
    expect(trailer.props.children.join('')).to.include('+2 more');
  });
});
