import type {DependencyGraphProvider, NimbusClassGraph} from '../../ports/dependency-graph.js';
import type {ValidationContext} from '../../ports/validation-context.js';
import type {NimbusAdapterDeps} from './config.js';

import {MetadataOwnership} from '../../boundary-check/metadata-ownership-index.js';
import {INSTALL_HINT, resolveNimbusBinary} from './nimbus-binary.js';
import {runNimbus} from './nimbus-process.js';

/** Maps file extension → metadata type. Add an entry here to support a new type. */
const TYPE_TO_PREFIX = new Map<string, MetadataOwnership['metadataType']>([
  ['apexclass', ''],
  ['apextrigger', ''],
  ['customlabel', 'Label'],
  ['custommetadata', ''],
  ['customobject', 'SObject'],
  ['flow', 'Flow'],
  ['permissionset', 'Permission'],
  ['staticreresource', 'Resource'],
]);

export class NimbusGraphProvider implements DependencyGraphProvider {
  constructor(private deps: NimbusAdapterDeps) {}

  async getMetadataDependencies(
    metadataName: string,
    metadataType: MetadataOwnership['metadataType'],
    context: Pick<ValidationContext, 'packageId' | 'projectRoot'>,
  ): Promise<NimbusClassGraph> {
    const logger = this.deps.logger?.child?.({
      component: 'graph',
      metadataName,
      packageId: context.packageId,
      validator: 'nimbus',
    }) ?? this.deps.logger;
    const binary = await resolveNimbusBinary(this.deps);

    if (!binary) throw new Error(`nimbus binary not found. ${INSTALL_HINT}`);

    if (!TYPE_TO_PREFIX.has(metadataType)) {
      throw new Error(`'${metadataName}' is of unsupported metadata type '${metadataType}' for graphing.`)
    }

    const prefix = TYPE_TO_PREFIX.get(metadataType);

    const {exitCode, stderr, stdout} = await runNimbus(
      binary,
      ['graph', `${prefix ? `${prefix}.${metadataName}` : metadataName}`,  '--json'],
      context.projectRoot,
      {logger},
    );
    if (exitCode !== 0) throw new Error(`nimbus graph ${metadataName} failed: ${stderr}`);
    return JSON.parse(stdout) as NimbusClassGraph;
  }
}
