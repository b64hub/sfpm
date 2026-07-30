import {
  findSfpmRoot, LifecycleEngine, loadSfpmConfig, type Logger,
} from '@b64hub/sfpm-core';
import {
  ArtifactPackageInstallTask, createPoolServices, DeploymentTask, type PoolConfig, type PoolOrgTask,
} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {ConfigAggregator, Org, OrgTypes} from '@salesforce/core';
import path from 'node:path';

import SfpmCommand from '../../sfpm-command.js';
import {connectDevHub} from '../../ui/connect-devhub.js';
import {renderPoolFill} from '../../ui/run-pool-fill.js';

import '@b64hub/sfpm-sfdmu';

export default class PoolFill extends SfpmCommand {
  static override description = 'fill a pool with orgs'
  static override examples = [
    '<%= config.bin %> pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub',
    '<%= config.bin %> pool fill --tag sb-pool --max 5 --type sandbox -d config/sandbox-def.json -v my-prod-org',
    '<%= config.bin %> pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub --json',
  ]
  static override flags = {
    'batch-size': Flags.integer({description: 'max concurrent org creations (default: 5)', min: 1}),
    'definition-file': Flags.string({char: 'd', description: 'org definition file (scratch org or sandbox)'}),
    'expiry-days': Flags.integer({description: 'scratch org expiry in days (default: 7)', min: 1}),
    max: Flags.integer({description: 'maximum number of orgs to allocate (overrides config)', min: 1}),
    'name-pattern': Flags.string({description: 'override sandbox name prefix from definition file (e.g., SB → SB1, SB2, ...)'}),
    tag: Flags.string({char: 't', description: 'pool tag', required: true}),
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

    const orgConfig = await this.loadOrgConfig(this.sfpmLogger);
    const config = this.buildPoolConfig(flags, orgConfig);
    const projectDir = process.env.SFPM_PROJECT_DIR || findSfpmRoot(process.cwd());
    const {logger: runLogger} = this.createRunLogger();

    if (!projectDir) {
      throw new Error('Unable to locate any project root files like sfpm.config.{ts,mjs,js}');
    }

    let manager: Awaited<ReturnType<typeof createPoolServices>>['manager'];
    let deployTask: DeploymentTask | undefined;

    const {alias} = await connectDevHub({
      alias: flags['target-dev-hub'],
      showSpinner: false,
      validate: [
        {
          label: 'Validating prerequisites...',
          run: async hub => {
            const tasks = this.buildTasks(config, hub, projectDir, flags['use-local-source']);
            deployTask = tasks.find((t): t is DeploymentTask => t instanceof DeploymentTask);
            const services = createPoolServices({
              devhub: hub,
              logger: runLogger,
              poolType: config.type as OrgTypes,
              tasks,
            });
            manager = services.manager;
            await manager.validatePrerequisites();
          },
        },
      ],
    });

    let result: Awaited<ReturnType<typeof manager.provision>>;

    if (mode === 'interactive') {
      // Wire per-package events from DeploymentTask through the pool manager
      deployTask?.setPackageForwarder({
        packageComplete: p => manager!.emit('pool:package:complete', {...p, timestamp: new Date()}),
        packageStart: p => manager!.emit('pool:package:start',    {...p, timestamp: new Date()}),
      });

      const inkInstance = renderPoolFill(manager!, alias);
      try {
        result = await manager!.provision(flags.tag as string, config);
        await inkInstance.waitUntilExit();
      } catch (error) {
        inkInstance.unmount();
        throw error;
      }
    } else {
      result = await manager!.provision(flags.tag as string, config);

      if (result.failed > 0 && result.succeeded.length === 0) {
        this.error(`Pool provisioning failed: ${result.errors.join(', ')}`, {exit: 1});
      }

      return {...result, events: [], success: result.failed === 0};
    }

    if (result.failed > 0 && result.succeeded.length === 0) {
      this.error(`Pool provisioning failed: ${result.errors.join(', ')}`, {exit: 1});
    }

    return {...result, events: [], success: result.failed === 0};
  }

  private buildPoolConfig(flags: Record<string, any>, orgConfig?: {[tag: string]: PoolConfig}): PoolConfig {
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const tag = flags.tag as string;

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

  private buildTasks(config: PoolConfig, devhub: Org, projectDir: string, useLocalSource?: boolean): PoolOrgTask[] {
    const tasks: PoolOrgTask[] = [];
    const isScratch = config.type === OrgTypes.Scratch;

    // Scratch orgs need the artifact tracking package installed first
    if (isScratch) {
      tasks.push(new ArtifactPackageInstallTask({devhub}));
    }

    // Deploy packages to the provisioned org
    tasks.push(new DeploymentTask({
      continueOnError: config.deployment?.continueOnError ?? true,
      testLevel: config.deployment?.testLevel,
      useLocalSource,
      workingDirectory: projectDir,
    }));

    return tasks;
  }

  private async loadOrgConfig(logger: Logger): Promise<undefined | {[tag: string]: PoolConfig}> {
    try {
      const sfpmConfig = await loadSfpmConfig(process.env.SFPM_PROJECT_DIR || process.cwd(), logger);
      return sfpmConfig.orgs as undefined | {[tag: string]: PoolConfig};
    } catch {
      return undefined;
    }
  }
}
