import type {OutputLogger, OutputMode} from '../renderer-utils.js';
import type {DisplayStrategy} from './display-strategy.js';

import {InteractiveDisplay} from './interactive.js';
import {PlainDisplay} from './plain.js';
import {SilentDisplay} from './silent.js';

export type {CompleteSummary, DisplayStrategy, PackageResultSummary} from './display-strategy.js';
export {InteractiveDisplay} from './interactive.js';
export {PlainDisplay} from './plain.js';
export {SilentDisplay} from './silent.js';

/**
 * Factory to create the appropriate display strategy for the given output mode.
 */
export function createDisplayStrategy(mode: OutputMode, logger: OutputLogger): DisplayStrategy {
  switch (mode) {
  case 'interactive': {
    return new InteractiveDisplay(logger);
  }

  case 'json': {
    return new SilentDisplay();
  }

  case 'plain': {
    return new PlainDisplay(logger);
  }
  }
}
