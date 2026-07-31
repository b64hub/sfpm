import type {Logger} from '@b64hub/sfpm-core'

import type {ValidationEventBus} from '../../contracts/validation-event-bus.js';

export interface NimbusDaemonConfig {
  autoStart: boolean;
  autoStop: boolean;
  enabled: boolean;
  idleTimeoutMs?: number;
}

export interface NimbusAdapterConfig {
  binaryPathOverride?: string;
  daemon: NimbusDaemonConfig;
  supportedVersionRange: string;
}

export interface NimbusAdapterDeps {
  config: NimbusAdapterConfig;
  eventBus: ValidationEventBus;
  logger: Logger;
}
