import {
  PackageDefinition, PackageNode, PackageType, ProjectGraph, ProjectService,
} from '@b64/sfpm-core'
import {Flags} from '@oclif/core'
import boxen from 'boxen'
import chalk from 'chalk'
import treeify from 'object-treeify'

import SfpmCommand from '../sfpm-command.js'

export default class Project extends SfpmCommand {
  static override description = 'Overview of the project'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
  ]
  static override flags = {
    path: Flags.boolean({
      char: 'p',
      default: false,
      description: 'Display package paths',
    }),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(Project);

    const config = await ProjectService.getProjectDefinition();
    const graph = new ProjectGraph(config);

    const treeData: Record<string, any> = {};

    for (const pkg of config.packageDirectories) {
      if (!('package' in pkg)) {
        continue;
      }

      const node = graph.getNode(pkg.package);
      if (!node) {
        continue;
      }

      const label = this.formatLabel(node, flags.path);
      treeData[label] = this.buildDependencyTree(node);
    }

    this.log(chalk.bold('Project Overview'));
    this.log(treeify(treeData));
    this.logLegend();
    this.log('\n');
  }

  private buildDependencyTree(node: PackageNode): null | Record<string, any> {
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

  private formatDependency(node: PackageNode): string {
    if (node.isManaged) {
      return `${chalk.green(node.name)} \t${chalk.green('(managed)')}`;
    }

    return `${chalk.grey(node.name)} \t@ ${chalk.grey(node.version ?? '0.0.0')}`;
  }

  private formatLabel(node: PackageNode, showPath: boolean = false): string {
    let colorFn = chalk.cyan

    if (node.isManaged) {
      colorFn = chalk.green
    } else switch ((node.definition as PackageDefinition).type) {
    case PackageType.Data: {
      colorFn = chalk.magenta

      break;
    }

    case PackageType.Diff: {
      colorFn = chalk.red

      break;
    }

    case PackageType.Source: {
      colorFn = chalk.yellow

      break;
    }
 // No default
    }

    let label = `${chalk.bold(colorFn(node.name))} \t@ ${chalk.blue(node.version ?? '0.0.0')}`;

    if (showPath && node.path) {
      label += chalk.gray(`\t- ${node.path}`);
    }

    return label;
  }

  private logLegend(): void {
    const legend = [
      `${chalk.cyan('■')} Unlocked`,
      `${chalk.yellow('■')} Source`,
      `${chalk.magenta('■')} Data`,
      `${chalk.red('■')} Diff`,
      `${chalk.green('■')} Managed`,
    ].join('  ');

    this.log('\n');
    this.log(boxen(legend, {
      borderColor: 'gray',
      borderStyle: 'round',
      padding: {
        bottom: 0, left: 1, right: 1, top: 0,
      },
      title: 'Legend',
      titleAlignment: 'left',
    }));
  }
}
