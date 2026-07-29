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
    step: Flags.boolean({
      default: false,
      description: 'Pause after each event and wait for a keypress (any key = advance, q = quit)',
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

    const delay = (ms: number) => new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });

    if (flags.step) {
      await this.runStepMode(events, bus);
    } else {
      // Auto-play: chain events with a fixed delay between each.
      const app = renderApp(bus);
      let chain = Promise.resolve();
      for (const {type, ...payload} of events) {
        chain = chain.then(() => delay(flags.speed)).then(() => {
          bus.emit(type, payload);
        });
      }

      await chain;
      await delay(800);
      app.unmount();
      await app.waitUntilExit();
    }
  }

  /**
   * Step mode: press any key to emit the next event, Ctrl-C / 'q' to quit.
   *
   * Wires keypresses through Ink's useInput (via the App's onAdvance prop)
   * so terminal management stays entirely within Ink — no raw-stdin conflicts.
   */
  private async runStepMode(
    events: Array<Record<string, unknown> & {type: string}>,

    bus: EventEmitter,
  ): Promise<void> {
    // Simple key queue: resolves the current waiter immediately, or buffers
    // if a key arrives before the next waitForKey() call.
    let waiter: ((key: string) => void) | undefined;
    const queue: string[] = [];

    const onAdvance = (key: string) => {
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve(key);
      } else {
        queue.push(key);
      }
    };

    const waitForKey = (): Promise<string> => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise(resolve => {
        waiter = resolve;
      });
    };

    const app = renderApp(bus, {onAdvance});

    for (let i = 0; i < events.length; i++) {
      const {type, ...payload} = events[i];
      // Show what's about to be emitted — below the Ink render on stderr.
      process.stderr.write(`\n[${i + 1}/${events.length}] ${type} — any key to advance, q to quit\n`);
      // eslint-disable-next-line no-await-in-loop
      const key = await waitForKey();
      if (key === 'q' || key === '\u0003') break; // q or Ctrl-C
      bus.emit(type, payload);
    }

    app.unmount();
    await app.waitUntilExit();
  }
}
