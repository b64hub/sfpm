import {
  ArtifactProvider, InstallOrchestrator, ProjectService, type TestLevel,
} from '@b64hub/sfpm-core'
import {Org} from '@salesforce/core'
import {execSync} from 'node:child_process'
import EventEmitter from 'node:events'

import {attachInstallBridge} from '../../ui/install-event-bridge.js'
import {InstallProgressRenderer} from '../../ui/install-progress-renderer.js'
import {renderApp} from '../../ui/run.js'
import Deploy, {ResolvedDeployFlags} from './index.js'

export default class DeployArtifact extends Deploy {
  static override description = 'deploy one or more packages from built artifacts using source-deploy'
  static override flags = {
    ...Deploy.flags,
  }

  protected override async createOrchestrator(targetOrg: Org, resolvedFlags: ResolvedDeployFlags): Promise<{
    inkInstance?: ReturnType<typeof renderApp>;
    orchestrator: InstallOrchestrator;
    renderer?: InstallProgressRenderer;
  }> {
    const {flags, logger, mode, projectConfig, projectGraph} = resolvedFlags

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
      logger,
    );

    if (mode === 'interactive') {
      const uiBus = new EventEmitter();
      attachInstallBridge(orchestrator.installBus, orchestrator.orchestrationBus, uiBus);
      return {inkInstance: renderApp(uiBus), orchestrator};
    }

    const renderer = this.createRenderer(mode, flags['target-org']!)
    renderer.attachTo(orchestrator.installBus, orchestrator.orchestrationBus)
    return {orchestrator, renderer}
  }

  protected override async createProjectService(projectDir: string, packages: string[]): Promise<ProjectService> {
    const pkgArgs = packages.map(p => `'${p}'`).join(' ');
    this.log(`Fetching artifacts: ${packages.join(', ')}`);
    execSync(`npm install --no-save ${pkgArgs}`, {cwd: projectDir, stdio: 'inherit'});

    const artifactProvider = new ArtifactProvider({logger: this.sfpmLogger, packages, projectDir});
    return ProjectService.create(projectDir, artifactProvider);
  }
}
