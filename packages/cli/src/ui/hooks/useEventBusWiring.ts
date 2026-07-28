import type EventEmitter from 'node:events';
import type {Dispatch} from 'react';

import {useEffect} from 'react';

const EVENT_NAMES = [
  'build:start', 'build:package:status', 'build:package:step', 'build:complete',
  'validation:start', 'validation:status',
  'install:start', 'install:progress', 'install:complete',
] as const;

type UiAction = {type: string} & Record<string, unknown>;

export function useEventBusWiring(bus: EventEmitter, dispatch: Dispatch<UiAction>): void {
  useEffect(() => {
    const handlers = EVENT_NAMES.map(name => {
      const handler = (payload: unknown) => dispatch({type: name, ...(payload as Record<string, unknown>)});
      bus.on(name, handler);
      return [name, handler] as const;
    });
    return () => handlers.forEach(([name, handler]) => bus.off(name, handler));
  }, [bus, dispatch]);
}
