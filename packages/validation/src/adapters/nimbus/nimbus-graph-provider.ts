import type {DependencyGraphProvider, NimbusClassGraph} from '../../ports/dependency-graph.js';
import type {ValidationContext} from '../../ports/validation-context.js';
import type {NimbusAdapterDeps} from './config.js';

import {INSTALL_HINT, resolveNimbusBinary} from './nimbus-binary.js';
import {runNimbus} from './nimbus-process.js';

export interface MetadataOwnership {
  filePath: string;
  metadataName: string;
  metadataType: 'apexclass' | 'apextrigger' | 'customfield' | 'customobject' | string;
  packageId: string;
}

/** Maps file extension → metadata type. Add an entry here to support a new type. */
const TYPE_TO_PREFIX = new Map<string, MetadataOwnership['metadataType']>([
  ['apexclass', ''],
  ['apextrigger', ''],
  ['customfield', ''],
  ['customobject', 'SObject'],
  ['flow', 'Flow.'],
]);

export function createNimbusGraphProvider(deps: NimbusAdapterDeps): DependencyGraphProvider {
  return {
    async getMetadataDependencies(
      metadataName: string,
      metadataType: MetadataOwnership['metadataType'],
      context: Pick<ValidationContext, 'packageId' | 'projectRoot'>,
    ): Promise<NimbusClassGraph> {
      const logger = deps.logger.child?.({
        component: 'graph',
        metadataName,
        packageId: context.packageId,
        validator: 'nimbus',
      }) ?? deps.logger;
      const binary = await resolveNimbusBinary(deps);
      if (!binary) throw new Error(`nimbus binary not found. ${INSTALL_HINT}`);
      const {exitCode, stderr, stdout} = await runNimbus(
        binary,
        ['graph', metadataName, '--json'],
        context.projectRoot,
        {logger},
      );
      if (exitCode !== 0) throw new Error(`nimbus graph ${metadataName} failed: ${stderr}`);
      return JSON.parse(stdout) as NimbusClassGraph;
    },
  };
}
