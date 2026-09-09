import {
  ArtifactProvider, InstallOrchestrator, ProjectService, type TestLevel,
} from '@b64hub/sfpm-core'
import {Org} from '@salesforce/core'
import {execSync} from 'node:child_process'
import EventEmitter from 'node:events'

import {attachInstallBridge} from '../../ui/adapters/install-event-bridge.js'
import {renderApp} from '../../ui/renderers/run-orchestrator.js'
import Deploy, {ResolvedDeployFlags} from './index.js'

export default class DeployArtifact extends Deploy {
  static override description = 'deploy packages from built artifacts using source-deploy'
  static override flags = {
    ...Deploy.flags,
  }

  protected override async createOrchestrator(targetOrg: Org, resolvedFlags: ResolvedDeployFlags): Promise<{
    inkInstance?: ReturnType<typeof renderApp>;
    orchestrator: InstallOrchestrator;
  }> {
    const {flags, logger, mode, projectConfig, projectGraph} = resolvedFlags

    // json is the only non-ink mode left; it's fully silent during the run
    // (the SfpmCommand base class emits the JSON envelope at the end).
    const isInk = mode !== 'json';
    const uiBus = isInk ? new EventEmitter() : undefined;
    const {logger: pinoLogger, logPath} = this.createRunLogger(uiBus);

    const orchestrator = InstallOrchestrator.forArtifact(
      targetOrg,
      projectConfig,
      projectGraph,
      {
        force: flags.force,
        includeDependencies: !flags['no-dependencies'],
        regressionTest: flags['regression-test'],
        unlocked: {sourceOnly: true},
      },
      pinoLogger,
    );

    if (isInk) {
      attachInstallBridge(orchestrator.installBus, orchestrator.orchestrationBus, uiBus!);
      return {inkInstance: renderApp(uiBus!, {logPath, mode: mode === 'interactive' ? 'interactive' : 'plain'}), orchestrator};
    }

    return {orchestrator}
  }

  protected override async createProjectService(projectDir: string, packages: string[]): Promise<ProjectService> {
    const pkgArgs = packages.map(p => `'${p}'`).join(' ');
    this.log(`Fetching artifacts: ${packages.join(', ')}`);
    execSync(`npm install --no-save ${pkgArgs}`, {cwd: projectDir, stdio: 'inherit'});

    const artifactProvider = new ArtifactProvider({logger: this.sfpmLogger, packages, projectDir});
    return ProjectService.create(projectDir, artifactProvider);
  }
}
