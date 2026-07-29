import type EventEmitter from 'node:events';
import type {Dispatch} from 'react';

import {useEffect} from 'react';

const EVENT_NAMES = [
  // Orchestration lifecycle
  'orchestration:init',
  'orchestration:complete',
  // Per-package
  'package:running',
  'package:complete',
  // Per-step within a package
  'step:start',
  'step:complete',
  'step:update',
  // Validation sidebar
  'validation:init',
  'validation:update',
  // Logs
  'log:append',
] as const;

type UiAction = Record<string, unknown> & {type: string};

export function useEventBusWiring(bus: EventEmitter, dispatch: Dispatch<UiAction>): void {
  useEffect(() => {
    const handlers = EVENT_NAMES.map(name => {
      const handler = (payload: unknown) => dispatch({type: name, ...(payload as Record<string, unknown>)});
      bus.on(name, handler);
      return [name, handler] as const;
    });
    return () => {
      for (const [name, handler] of handlers) bus.off(name, handler)
    };
  }, [bus, dispatch]);
}
