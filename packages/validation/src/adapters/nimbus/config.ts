import type {Logger} from '@b64hub/sfpm-core'

import type {ValidationEventBus} from '../../types/validation-event-bus.js';

export interface NimbusDaemonConfig {
  autoStart: boolean;
  autoStop: boolean;
  enabled: boolean;
  idleTimeoutMs?: number;
}

/** Nimbus binary versions sfpm is tested and compatible with. Update when integrating a new nimbus release. */
export const NIMBUS_SUPPORTED_VERSION_RANGE = '^1.16.1';

export interface NimbusAdapterConfig {
  binaryPathOverride?: string;
  daemon: NimbusDaemonConfig;
  /** @default NIMBUS_SUPPORTED_VERSION_RANGE */
  supportedVersionRange?: string;
}

export interface NimbusAdapterDeps {
  config: NimbusAdapterConfig;
  eventBus: ValidationEventBus;
  logger: Logger;
}
