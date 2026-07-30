import {Args, Flags} from '@oclif/core';
import EventEmitter from 'node:events';
import {render} from 'ink';

import SfpmCommand from '../../sfpm-command.js';
import {PoolFillApp} from '../../ui/apps/PoolFillApp.js';

const FIXTURES: Record<string, Array<Record<string, unknown> & {type: string}>> = {
  'happy-path':      (await import('../../ui/fixtures/pool-happy-path.js')).poolHappyPathEvents,
  'partial-failure': (await import('../../ui/fixtures/pool-partial-failure.js')).poolPartialFailureEvents,
};

export default class DevPoolReplay extends SfpmCommand {
  static override args = {
    fixture: Args.string({
      default: 'happy-path',
      description: `Fixture to replay. Available: ${Object.keys(FIXTURES).join(', ')}`,
    }),
  };
  static override description = 'Replay a pool fill UI fixture (dev only)';
  static override enableJsonFlag = false;
  static override flags = {
    alias: Flags.string({default: 'my-devhub', description: 'DevHub alias shown in the badge'}),
    speed: Flags.integer({default: 150, description: 'Milliseconds between events', min: 0}),
    step: Flags.boolean({default: false, description: 'Pause after each event and wait for a keypress'}),
  };
  static override hidden = true;

  public async execute(): Promise<void> {
    const {args, flags} = await this.parse(DevPoolReplay);
    const events = FIXTURES[args.fixture];
    if (!events) {
      this.error(`Unknown fixture "${args.fixture}". Available: ${Object.keys(FIXTURES).join(', ')}`);
    }

    const bus = new EventEmitter();
    const delay = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

    if (flags.step) {
      await this.runStepMode(events, bus, flags.alias);
    } else {
      const app = render(<PoolFillApp bus={bus} devhubAlias={flags.alias} />);

      let chain = Promise.resolve();
      for (const {type, ...payload} of events) {
        chain = chain.then(() => delay(flags.speed)).then(() => { bus.emit(type, payload); });
      }

      await chain;
      await delay(800);
      app.unmount();
      await app.waitUntilExit();
    }
  }

  private async runStepMode(
    events: Array<Record<string, unknown> & {type: string}>,
    bus: EventEmitter,
    devhubAlias: string,
  ): Promise<void> {
    let waiter: ((key: string) => void) | undefined;
    const queue: string[] = [];

    const onAdvance = (key: string) => {
      if (waiter) { const r = waiter; waiter = undefined; r(key); }
      else queue.push(key);
    };

    const waitForKey = (): Promise<string> => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise(resolve => { waiter = resolve; });
    };

    const app = render(<PoolFillApp bus={bus} devhubAlias={devhubAlias} onAdvance={onAdvance} />);

    for (let i = 0; i < events.length; i++) {
      const {type, ...payload} = events[i];
      process.stderr.write(`\n[${i + 1}/${events.length}] ${type} — any key to advance, q to quit\n`);
      // eslint-disable-next-line no-await-in-loop
      const key = await waitForKey();
      if (key === 'q' || key === '\u0003') break;
      bus.emit(type, payload);
    }

    app.unmount();
    await app.waitUntilExit();
  }
}
