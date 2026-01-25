import SfpmCommand from '../sfpm-command.js'
import { ProjectService, ProjectGraph, PackageNode, PackageType } from '@b64/sfpm-core'
import treeify from 'object-treeify'
import chalk from 'chalk'
import { Flags } from '@oclif/core'
import boxen from 'boxen'

export default class Project extends SfpmCommand {

  static override description = 'Overview of the project'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
  ]

  static override flags = {
    path: Flags.boolean({
      char: 'p',
      description: 'Display package paths',
      default: false,
    })
  }

  public async execute(): Promise<void> {
    const { flags } = await this.parse(Project);

    const config = await ProjectService.getProjectDefinition();
    const graph = new ProjectGraph(config);

    const treeData: Record<string, any> = {};

    for (const pkg of config.packageDirectories) {
      const node = graph.getNode(pkg.package);
      if (!node) continue;

      const label = this.formatLabel(node, flags.path);
      treeData[label] = this.buildDependencyTree(node);
    }

    this.log(chalk.bold('Project Overview'));
    this.log(treeify(treeData));
    this.logLegend();
    this.log('\n');
  }

  private formatLabel(node: PackageNode, showPath: boolean = false): string {
    let colorFn = chalk.cyan

    if (node.definition.type === PackageType.Source) {
      colorFn = chalk.yellow
    } else if (node.definition.type === PackageType.Data) {
      colorFn = chalk.magenta
    } else if (node.definition.type === PackageType.Diff) {
      colorFn = chalk.red
    }

    let label = `${chalk.bold(colorFn(node.name))} \t@ ${chalk.blue(node.version ?? '0.0.0')}`;

    if (showPath && node.path) {
      label += chalk.gray(`\t- ${node.path}`);
    }
    return label;
  }

  private formatDependency(node: PackageNode): string {
    return `${chalk.grey(node.name)} \t@ ${chalk.grey(node.version ?? '0.0.0')}`;
  }

  private buildDependencyTree(node: PackageNode): Record<string, any> | null {
    if (node.dependencies.size === 0) {
      return null;
    }

    const deps: Record<string, any> = {};
    for (const dep of node.dependencies) {
      const label = this.formatDependency(dep);
      deps[label] = null; // We only show one level deep to avoid infinite recursion/clutter
    }
    return deps;
  }

  private logLegend(): void {
    const legend = [
      `${chalk.cyan('■')} Unlocked`,
      `${chalk.yellow('■')} Source`,
      `${chalk.magenta('■')} Data`,
      `${chalk.red('■')} Diff`
    ].join('  ');

    this.log('\n');
    this.log(boxen(legend, {
      title: 'Legend',
      titleAlignment: 'left',
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      borderStyle: 'round',
      borderColor: 'gray'
    }));
  }
}
