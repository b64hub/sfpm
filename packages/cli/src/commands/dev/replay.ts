import {Args, Flags} from '@oclif/core';
import EventEmitter from 'node:events';

import SfpmCommand from '../../sfpm-command.js';
import {renderApp} from '../../ui/run.js';

// Built-in fixtures — same arrays the unit tests use.
const FIXTURES: Record<string, Array<Record<string, unknown> & {type: string}>> = {
  'happy-path': (await import('../../ui/fixtures/happy-path.js')).happyPathEvents,
  'large-scale': (await import('../../ui/fixtures/large-scale.js')).largeBuildEvents,
  'partial-failure': (await import('../../ui/fixtures/partial-failure.js')).partialFailureEvents,
};

export default class DevReplay extends SfpmCommand {
  static override args = {
    fixture: Args.string({
      default: 'happy-path',
      description: `Fixture name to replay. Available: ${Object.keys(FIXTURES).join(', ')}`,
    }),
  };
  static override description = 'Replay a UI fixture through the Ink build UI (dev only)';
  static override enableJsonFlag = false;
  static override flags = {
    speed: Flags.integer({
      default: 120,
      description: 'Milliseconds between events',
      min: 0,
    }),
  };
  static override hidden = true;

  public async execute(): Promise<void> {
    const {args, flags} = await this.parse(DevReplay);
    const events = FIXTURES[args.fixture];
    if (!events) {
      this.error(`Unknown fixture "${args.fixture}". Available: ${Object.keys(FIXTURES).join(', ')}`);
    }

    const bus = new EventEmitter();
    const app = renderApp(bus);

    const delay = (ms: number) => new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });

    // Chain events sequentially — intentionally serial, each waits before emitting
    let chain = Promise.resolve();
    for (const {type, ...payload} of events) {
      chain = chain.then(() => delay(flags.speed)).then(() => {
        bus.emit(type, payload);
      });
    }

    await chain;

    // Hold the final frame briefly, then clean up
    await delay(800);
    app.unmount();
    await app.waitUntilExit();
  }
}
