sfpm
=================

sfpm is the devops tool Salesforce engineers have been waiting for


[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/sfp.svg)](https://npmjs.org/package/sfpm)
[![Downloads/week](https://img.shields.io/npm/dw/sfp.svg)](https://npmjs.org/package/sfpm)


<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g @b64hub/sfpm-cli
$ sfpm COMMAND
running command...
$ sfpm (--version)
@b64hub/sfpm-cli/0.1.0 darwin-arm64 node-v25.2.1
$ sfpm --help [COMMAND]
USAGE
  $ sfpm COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`sfpm help [COMMAND]`](#sfpm-help-command)
* [`sfpm plugins`](#sfpm-plugins)
* [`sfpm plugins add PLUGIN`](#sfpm-plugins-add-plugin)
* [`sfpm plugins:inspect PLUGIN...`](#sfpm-pluginsinspect-plugin)
* [`sfpm plugins install PLUGIN`](#sfpm-plugins-install-plugin)
* [`sfpm plugins link PATH`](#sfpm-plugins-link-path)
* [`sfpm plugins remove [PLUGIN]`](#sfpm-plugins-remove-plugin)
* [`sfpm plugins reset`](#sfpm-plugins-reset)
* [`sfpm plugins uninstall [PLUGIN]`](#sfpm-plugins-uninstall-plugin)
* [`sfpm plugins unlink [PLUGIN]`](#sfpm-plugins-unlink-plugin)
* [`sfpm plugins update`](#sfpm-plugins-update)

## `sfpm help [COMMAND]`

Display help for sfpm.

```
USAGE
  $ sfpm help [COMMAND...] [-n]

ARGUMENTS
  [COMMAND...]  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for sfpm.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v6.2.37/src/commands/help.ts)_

## `sfpm plugins`

List installed plugins.

```
USAGE
  $ sfpm plugins [--json] [--core]

FLAGS
  --core  Show core plugins.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List installed plugins.

EXAMPLES
  $ sfpm plugins
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.55/src/commands/plugins/index.ts)_

## `sfpm plugins add PLUGIN`

Installs a plugin into sfpm.

```
USAGE
  $ sfpm plugins add PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into sfpm.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the SFPM_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the SFPM_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ sfpm plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ sfpm plugins add myplugin

  Install a plugin from a github url.

    $ sfpm plugins add https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ sfpm plugins add someuser/someplugin
```

## `sfpm plugins:inspect PLUGIN...`

Displays installation properties of a plugin.

```
USAGE
  $ sfpm plugins inspect PLUGIN...

ARGUMENTS
  PLUGIN...  [default: .] Plugin to inspect.

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Displays installation properties of a plugin.

EXAMPLES
  $ sfpm plugins inspect myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.55/src/commands/plugins/inspect.ts)_

## `sfpm plugins install PLUGIN`

Installs a plugin into sfpm.

```
USAGE
  $ sfpm plugins install PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into sfpm.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the SFPM_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the SFPM_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ sfpm plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ sfpm plugins install myplugin

  Install a plugin from a github url.

    $ sfpm plugins install https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ sfpm plugins install someuser/someplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.55/src/commands/plugins/install.ts)_

## `sfpm plugins link PATH`

Links a plugin into the CLI for development.

```
USAGE
  $ sfpm plugins link PATH [-h] [--install] [-v]

ARGUMENTS
  PATH  [default: .] path to plugin

FLAGS
  -h, --help          Show CLI help.
  -v, --verbose
      --[no-]install  Install dependencies after linking the plugin.

DESCRIPTION
  Links a plugin into the CLI for development.

  Installation of a linked plugin will override a user-installed or core plugin.

  e.g. If you have a user-installed or core plugin that has a 'hello' command, installing a linked plugin with a 'hello'
  command will override the user-installed or core plugin implementation. This is useful for development work.


EXAMPLES
  $ sfpm plugins link myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.55/src/commands/plugins/link.ts)_

## `sfpm plugins remove [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ sfpm plugins remove [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ sfpm plugins unlink
  $ sfpm plugins remove

EXAMPLES
  $ sfpm plugins remove myplugin
```

## `sfpm plugins reset`

Remove all user-installed and linked plugins.

```
USAGE
  $ sfpm plugins reset [--hard] [--reinstall]

FLAGS
  --hard       Delete node_modules and package manager related files in addition to uninstalling plugins.
  --reinstall  Reinstall all plugins after uninstalling.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.55/src/commands/plugins/reset.ts)_

## `sfpm plugins uninstall [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ sfpm plugins uninstall [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ sfpm plugins unlink
  $ sfpm plugins remove

EXAMPLES
  $ sfpm plugins uninstall myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.55/src/commands/plugins/uninstall.ts)_

## `sfpm plugins unlink [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ sfpm plugins unlink [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ sfpm plugins unlink
  $ sfpm plugins remove

EXAMPLES
  $ sfpm plugins unlink myplugin
```

## `sfpm plugins update`

Update installed plugins.

```
USAGE
  $ sfpm plugins update [-h] [-v]

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Update installed plugins.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/v5.4.55/src/commands/plugins/update.ts)_
<!-- commandsstop -->
