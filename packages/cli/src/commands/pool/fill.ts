import {
  LifecycleEngine, loadSfpmConfig, type Logger,
} from '@b64hub/sfpm-core';
import {
  ArtifactPackageInstallTask, createPoolServices, DeploymentTask, type PoolConfig, type PoolOrgTask, type PoolProvisionResult,
} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {ConfigAggregator, Org, OrgTypes} from '@salesforce/core';
import EventEmitter from 'node:events';
import path from 'node:path';

import SfpmCommand from '../../sfpm-command.js';
import {connectDevHub} from '../../ui/connect-devhub.js';
import {attachPoolFillBridge} from '../../ui/pool-fill-event-bridge.js';
import {renderPoolFill} from '../../ui/run-pool-fill.js';
import {resolveCliProjectDir} from '../../utils/project-dir.js';

import '@b64hub/sfpm-sfdmu';

export default class PoolFill extends SfpmCommand {
  static override description = 'fill a pool with orgs'
  static override examples = [
    '<%= config.bin %> pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub',
    '<%= config.bin %> pool fill --tag sb-pool --max 5 --type sandbox -d config/sandbox-def.json -v my-prod-org',
    '<%= config.bin %> pool fill --tag dev-pool --tag qa-pool --max 10 -d config/project-scratch-def.json -v my-devhub',
    '<%= config.bin %> pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub --json',
  ]
  static override flags = {
    'batch-size': Flags.integer({description: 'max concurrent org creations (default: 5)', min: 1}),
    'definition-file': Flags.string({char: 'd', description: 'org definition file (scratch org or sandbox)'}),
    'expiry-days': Flags.integer({description: 'scratch org expiry in days (default: 7)', min: 1}),
    max: Flags.integer({description: 'maximum number of orgs to allocate (overrides config)', min: 1}),
    'name-pattern': Flags.string({description: 'override sandbox name prefix from definition file (e.g., SB → SB1, SB2, ...)'}),
    tag: Flags.string({
      char: 't', description: 'pool tag (repeat to fill multiple pools)', multiple: true, required: true,
    }),
    'target-dev-hub': Flags.string({
      char: 'v',
      async defaultHelp() {
        try {
          const configAggregator = await ConfigAggregator.create();
          return configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined;
        } catch {

        }
      },
      description: 'target hub org username or alias',
    }),
    type: Flags.string({
      description: 'pool type: scratch or sandbox (inferred from config if omitted)',
      options: [OrgTypes.Scratch, OrgTypes.Sandbox],
    }),
    'use-local-source': Flags.boolean({description: 'deploy from local project source instead of downloaded artifacts'}),
  }

  public async execute(): Promise<any> {
    const {flags} = await this.parse(PoolFill);
    const mode = this.outputMode;

    LifecycleEngine.stage('pool');

    const projectDir = resolveCliProjectDir();
    const orgConfig = await this.loadOrgConfig(this.sfpmLogger, projectDir);
    const tags = flags.tag as string[];
    const uiBus = mode === 'interactive' ? new EventEmitter() : undefined;
    const {logger: runLogger} = this.createRunLogger(uiBus);

    const {alias, devhub} = await connectDevHub({
      alias: flags['target-dev-hub'],
      showSpinner: mode === 'interactive',
    });

    // One Ink instance for the whole run — every tag's manager bridges its
    // events onto the same uiBus, tagged, so pools provision concurrently
    // and appear side by side instead of one after another.
    const inkInstance = mode === 'interactive' ? renderPoolFill(uiBus!, alias) : undefined;

    let results: Array<Awaited<ReturnType<typeof this.provisionTag>>>;
    try {
      results = await Promise.all(tags.map(tag => this.provisionTag({
        config: this.buildPoolConfig(flags, tag, projectDir, orgConfig),
        devhub,
        mode,
        projectDir,
        runLogger: runLogger.child({tag}),
        tag,
        uiBus,
        useLocalSource: flags['use-local-source'],
      })));
    } catch (error) {
      inkInstance?.unmount();
      throw error;
    }

    if (inkInstance) {
      await inkInstance.waitUntilExit();
    }

    const failures = results.filter(r => r.failed > 0 && r.succeeded.length === 0);
    if (failures.length > 0) {
      this.error(`Pool provisioning failed for ${failures.map(r => r.tag).join(', ')}: ${failures.flatMap(r => r.errors).join(', ')}`, {exit: 1});
    }

    const enriched = results.map(r => ({...r, events: [], success: r.failed === 0}));
    return tags.length === 1 ? enriched[0] : {results: enriched, success: enriched.every(r => r.success)};
  }

  private buildPoolConfig(flags: Record<string, any>, tag: string, projectDir: string, orgConfig?: {[tag: string]: PoolConfig}): PoolConfig {
    // Resolved pool config from defineOrgConfig (already merged with defaults)
    const poolConfig = orgConfig?.[tag];

    if (!poolConfig && !flags.type) {
      throw new Error(`No pool config found for tag "${tag}". Provide pool configuration in sfpm.config.ts or use CLI flags.`);
    }

    // Flag overrides take precedence over resolved config
    const type = (flags.type as string | undefined) ?? poolConfig?.type ?? 'scratch';
    const definitionFile = (flags['definition-file'] as string | undefined) ?? poolConfig?.definitionFile;
    if (!definitionFile) {
      throw new Error('--definition-file is required (or configure definitionFile in pool/scratch/sandbox config)');
    }

    const max = (flags.max as number | undefined) ?? poolConfig?.sizing?.max;
    if (!max) {
      throw new Error('--max is required (or configure sizing.max in pool config)');
    }

    const sizing = {
      batch: (flags['batch-size'] as number | undefined) ?? poolConfig?.sizing?.batch ?? 5,
      max,
    };

    if (type === 'sandbox') {
      return {
        ...poolConfig,
        definitionFile: path.resolve(projectDir, definitionFile),
        namePattern: (flags['name-pattern'] as string | undefined) ?? (poolConfig as any)?.namePattern,
        sizing,
        type: OrgTypes.Sandbox,
      } as PoolConfig;
    }

    return {
      ...poolConfig,
      definitionFile: path.resolve(projectDir, definitionFile),
      expiryDays: (flags['expiry-days'] as number | undefined) ?? (poolConfig as any)?.expiryDays,
      sizing,
      type: OrgTypes.Scratch,
    } as PoolConfig;
  }

  private buildTasks(config: PoolConfig, devhub: Org, projectDir: string, useLocalSource?: boolean): {deployTask: DeploymentTask; tasks: PoolOrgTask[]} {
    const deployTask = new DeploymentTask({
      continueOnError: config.deployment?.continueOnError ?? true,
      testLevel: config.deployment?.testLevel,
      useLocalSource,
      workingDirectory: projectDir,
    });

    // Scratch orgs need the artifact tracking package installed first, then packages deployed
    const tasks: PoolOrgTask[] = config.type === OrgTypes.Scratch
      ? [new ArtifactPackageInstallTask({devhub}), deployTask]
      : [deployTask];

    return {deployTask, tasks};
  }

  private async loadOrgConfig(logger: Logger, projectDir: string): Promise<undefined | {[tag: string]: PoolConfig}> {
    try {
      const sfpmConfig = await loadSfpmConfig(projectDir, logger);
      return sfpmConfig.orgs as undefined | {[tag: string]: PoolConfig};
    } catch {
      return undefined;
    }
  }

  private async provisionTag(options: {
    config: PoolConfig; devhub: Org; mode: string; projectDir: string; runLogger: Logger; tag: string; uiBus?: EventEmitter; useLocalSource?: boolean;
  }): Promise<PoolProvisionResult> {
    const {config, devhub, mode, projectDir, runLogger, tag, uiBus, useLocalSource} = options;

    const {deployTask, tasks} = this.buildTasks(config, devhub, projectDir, useLocalSource);
    const {manager} = createPoolServices({
      devhub,
      logger: runLogger,
      poolType: config.type as OrgTypes,
      tasks,
    });

    if (mode === 'interactive') {
      attachPoolFillBridge(manager.bus, uiBus!, tag);
      // Wire per-package events from DeploymentTask through the pool manager
      deployTask.setPackageForwarder({
        packageComplete: p => manager.bus.emit('pool:package:complete', {...p, timestamp: new Date()}),
        packageStart: p => manager.bus.emit('pool:package:start',    {...p, timestamp: new Date()}),
      });
    }

    await manager.validatePrerequisites();
    return manager.provision(tag, config);
  }
}
