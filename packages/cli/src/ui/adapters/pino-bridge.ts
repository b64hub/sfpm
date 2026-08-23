import type EventEmitter from 'node:events';

import {Writable} from 'node:stream';

/**
 * Creates a Writable stream that parses pino JSON log lines and emits
 * 'log:append' events on the given bus for the ink App to consume.
 *
 * Usage:
 *   const bridge = createPinoBridge(uiBus);
 *   const logger = new CliLogger(pino({ level: 'debug' }, bridge));
 */
export function createPinoBridge(bus: EventEmitter): Writable {
  return new Writable({
    write(chunk, _enc, callback) {
      try {
        const record = JSON.parse(chunk.toString());
        bus.emit('log:append', record);
      } catch {
        // malformed line — ignore
      }

      callback();
    },
  });
}
