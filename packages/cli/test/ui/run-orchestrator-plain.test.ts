import {expect} from 'chai';
import EventEmitter from 'node:events';

import {renderOrchestratorPlain} from '../../src/ui/renderers/run-orchestrator-plain.js';

describe('renderOrchestratorPlain', () => {
  let lines: string[];
  let originalLog: typeof console.log;
  let bus: EventEmitter;

  beforeEach(() => {
    lines = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    bus = new EventEmitter();
  });

  afterEach(() => {
    console.log = originalLog;
  });

  function failPackage(packageName: string, errorDetails?: Array<{label: string; message: string}>, detail = 'deploy failed'): void {
    bus.emit('package:complete', {detail, errorDetails, packageName, status: 'failed'});
  }

  function bulletsOf(output: string[]): string[] {
    return output.filter(l => l.startsWith('  - ') || l.startsWith('  +'));
  }

  it('prints only the summary line when errorDetails is undefined', () => {
    renderOrchestratorPlain(bus);
    failPackage('pkg-a', undefined);

    expect(lines).to.deep.equal(['pkg-a: failed — deploy failed']);
  });

  it('prints only the summary line when errorDetails is empty', () => {
    renderOrchestratorPlain(bus);
    failPackage('pkg-a', []);

    expect(lines).to.deep.equal(['pkg-a: failed — deploy failed']);
  });

  it('prints every reason as a bullet when there are 3 errorDetails', () => {
    renderOrchestratorPlain(bus);
    failPackage('pkg-a', [
      {label: 'ApexClass:A', message: 'Compile error'},
      {label: 'ApexClass:B', message: 'Missing field'},
      {label: 'CustomObject:C', message: 'Invalid type'},
    ]);

    expect(lines).to.deep.equal([
      'pkg-a: failed — deploy failed',
      '  - ApexClass:A: Compile error',
      '  - ApexClass:B: Missing field',
      '  - CustomObject:C: Invalid type',
    ]);
  });

  it('caps at 5 bullets and prints a "+N more" line with the log path for 12 errorDetails', () => {
    renderOrchestratorPlain(bus, {logPath: '/tmp/run.log'});
    failPackage('pkg-a', Array.from({length: 12}, (_, i) => ({label: `C${i}`, message: `problem ${i}`})));

    const bullets = bulletsOf(lines);
    expect(bullets).to.have.lengthOf(6);
    expect(bullets.slice(0, 5).map(l => l.split(':')[0])).to.deep.equal(['  - C0', '  - C1', '  - C2', '  - C3', '  - C4']);
    expect(bullets[5]).to.equal('  +7 more — see full logs: /tmp/run.log');
  });

  it('omits the log path from the "+N more" line when no logPath is given', () => {
    renderOrchestratorPlain(bus);
    failPackage('pkg-a', Array.from({length: 6}, (_, i) => ({label: `C${i}`, message: 'x'})));

    expect(lines.at(-1)).to.equal('  +1 more — see full logs');
  });

  it('squashes embedded newlines and extra whitespace into a single bullet line', () => {
    renderOrchestratorPlain(bus);
    failPackage('pkg-a', [
      {label: 'ApexClass:A', message: '  Line one\n\n   line two\t\tend  \n'},
    ]);

    expect(lines).to.deep.equal([
      'pkg-a: failed — deploy failed',
      '  - ApexClass:A: Line one line two end',
    ]);
  });

  it('prints the failed block once when a validating status precedes the failed status', () => {
    renderOrchestratorPlain(bus);
    bus.emit('package:complete', {packageName: 'pkg-a', status: 'validating'});
    failPackage('pkg-a', [{label: 'ApexClass:A', message: 'Compile error'}]);

    expect(lines).to.deep.equal([
      'pkg-a: failed — deploy failed',
      '  - ApexClass:A: Compile error',
    ]);
  });

  it('prints a "Full logs" line on failed orchestration when a logPath is given', () => {
    renderOrchestratorPlain(bus, {logPath: '/tmp/run.log'});
    bus.emit('orchestration:complete', {success: false});

    expect(lines).to.deep.equal(['failed', 'Full logs: /tmp/run.log']);
  });

  it('does not print a "Full logs" line when orchestration succeeds', () => {
    renderOrchestratorPlain(bus, {logPath: '/tmp/run.log'});
    bus.emit('orchestration:complete', {success: true});

    expect(lines).to.deep.equal(['succeeded']);
  });
});
