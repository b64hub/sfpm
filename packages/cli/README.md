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
* [`sfpm add PACKAGES`](#sfpm-add-packages)
* [`sfpm bootstrap`](#sfpm-bootstrap)
* [`sfpm build PACKAGES`](#sfpm-build-packages)
* [`sfpm build status`](#sfpm-build-status)
* [`sfpm deploy PACKAGES`](#sfpm-deploy-packages)
* [`sfpm deploy artifact PACKAGES`](#sfpm-deploy-artifact-packages)
* [`sfpm help [COMMAND]`](#sfpm-help-command)
* [`sfpm install PACKAGES`](#sfpm-install-packages)
* [`sfpm package create`](#sfpm-package-create)
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
* [`sfpm pool delete`](#sfpm-pool-delete)
* [`sfpm pool fetch`](#sfpm-pool-fetch)
* [`sfpm pool fill`](#sfpm-pool-fill)
* [`sfpm pool list`](#sfpm-pool-list)
* [`sfpm project`](#sfpm-project)
* [`sfpm project init`](#sfpm-project-init)
* [`sfpm project init turbo`](#sfpm-project-init-turbo)
* [`sfpm project sync`](#sfpm-project-sync)
* [`sfpm project version bump`](#sfpm-project-version-bump)
* [`sfpm publish [PACKAGES]`](#sfpm-publish-packages)
* [`sfpm watch cancel ID`](#sfpm-watch-cancel-id)
* [`sfpm watch clean`](#sfpm-watch-clean)
* [`sfpm watch status`](#sfpm-watch-status)

## `sfpm add PACKAGES`

add one or more sfpm packages as dependencies

```
USAGE
  $ sfpm add PACKAGES... [--json | --plain] [--log-level
    trace|debug|info|warn|error]

ARGUMENTS
  PACKAGES...  package(s) to add

FLAGS
  --json                output result as JSON
  --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                        <options: trace|debug|info|warn|error>
  --plain               non-interactive output (no spinners or cursor movement)

DESCRIPTION
  add one or more sfpm packages as dependencies

EXAMPLES
  $ sfpm add @myorg/my-package

  $ sfpm add @myorg/package-a @myorg/package-b
```

_See code: [dist/commands/add.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/add.js)_

## `sfpm bootstrap`

Bootstrap SFPM packages into a production org

```
USAGE
  $ sfpm bootstrap -o <value> [--json | --plain] [--log-level
    trace|debug|info|warn|error] [-f] [-t core|pool|full]

FLAGS
  -f, --force               force rebuild, re-promote, and re-install all packages
  -o, --target-org=<value>  (required) target org username (must also be a DevHub)
  -t, --tier=<option>       package tier to install
                            <options: core|pool|full>
      --json                output result as JSON
      --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                            <options: trace|debug|info|warn|error>
      --plain               non-interactive output (no spinners or cursor movement)

DESCRIPTION
  Bootstrap SFPM packages into a production org

EXAMPLES
  $ sfpm bootstrap -o my-prod-org

  $ sfpm bootstrap -o my-prod-org --tier core

  $ sfpm bootstrap -o my-prod-org --tier full --json

  $ sfpm bootstrap -o my-prod-org --force
```

_See code: [dist/commands/bootstrap.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/bootstrap.js)_

## `sfpm build PACKAGES`

build one or more packages

```
USAGE
  $ sfpm build PACKAGES... [--json | --plain] [--log-level
    trace|debug|info|warn|error] [--async] [-b <value>] [-o <value>] [-f] [-k <value>] [--no-dependencies]
    [--source-only] [-t <value>] [-v <value>] [--turbo] [-l local|org|full] [-w <value>]

ARGUMENTS
  PACKAGES...  package(s) to build

FLAGS
  -b, --build-number=<value>      build number
  -f, --force                     [env: SFPM_FORCE_BUILD] build even if no source changes detected
  -k, --installation-key=<value>  installation key
  -l, --validation=<option>       [default: local] validation level (use --no-validation to skip)
                                  <options: local|org|full>
  -o, --build-org=<value>         target org for source package validation (deploy + test)
  -t, --tag=<value>               tag for the build
  -v, --target-dev-hub=<value>    [default: dev-niko, env: SF_DEV_HUB] target dev hub username
  -w, --wait=<value>              [default: 120] timeout in minutes for package version creation
      --async                     return immediately without waiting for validation results
      --json                      output result as JSON
      --log-level=<option>        [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                                  <options: trace|debug|info|warn|error>
      --no-dependencies           build the specified packages without their transitive dependencies
      --plain                     non-interactive output (no spinners or cursor movement)
      --source-only               [env: SFPM_SOURCE_ONLY] route all packages through source deployment (no DevHub, no
                                  package version IDs)
      --turbo                     single-package mode for external orchestrators (implies --no-dependencies)

DESCRIPTION
  build one or more packages

EXAMPLES
  $ sfpm build my-package -v my-devhub

  $ sfpm build my-package -v my-devhub --plain

  $ sfpm build my-package -v my-devhub --json

  $ sfpm build my-package -v my-devhub --force

  $ sfpm build package-a package-b -v my-devhub
```

_See code: [dist/commands/build/index.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/build/index.js)_

## `sfpm build status`

check the status of async build watchers

```
USAGE
  $ sfpm build status [--log-level trace|debug|info|warn|error]
    [--plain | --json] [--poll]

FLAGS
  --json                output as JSON
  --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                        <options: trace|debug|info|warn|error>
  --plain               non-interactive output (no spinners or cursor movement)
  --poll                poll Salesforce directly for current status

DESCRIPTION
  check the status of async build watchers

EXAMPLES
  $ sfpm build status

  $ sfpm build status --json

  $ sfpm build status --poll
```

_See code: [dist/commands/build/status.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/build/status.js)_

## `sfpm deploy PACKAGES`

deploy one or more packages from local project source

```
USAGE
  $ sfpm deploy PACKAGES... [--json | --plain] [--log-level
    trace|debug|info|warn|error] [-f] [--no-dependencies] [--no-hooks] [--regression-test] [-o <value>] [-l
    NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg] [--turbo]

ARGUMENTS
  PACKAGES...  package(s) to deploy

FLAGS
  -f, --force                force deploy even if already installed
  -l, --test-level=<option>  deployment test level
                             <options: NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg>
  -o, --target-org=<value>   [env: SF_TARGET_ORG] target org username
      --json                 output result as JSON
      --log-level=<option>   [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                             <options: trace|debug|info|warn|error>
      --no-dependencies      only deploy the specified packages, skip transitive dependencies
      --no-hooks             skip lifecycle hooks
      --plain                non-interactive output (no spinners or cursor movement)
      --regression-test      run tests in direct dependents after deploy to detect regressions
      --turbo                single-package mode for external orchestrators (implies --no-dependencies --force)

DESCRIPTION
  deploy one or more packages from local project source

EXAMPLES
  $ sfpm deploy my-package -o my-sandbox

  $ sfpm deploy my-package -o my-sandbox --plain

  $ sfpm deploy my-package -o my-sandbox --json

  $ sfpm deploy package-a package-b -o my-sandbox
```

_See code: [dist/commands/deploy/index.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/deploy/index.js)_

## `sfpm deploy artifact PACKAGES`

deploy one or more packages from built artifacts using source-deploy

```
USAGE
  $ sfpm deploy artifact PACKAGES... [--json | --plain] [--log-level
    trace|debug|info|warn|error] [-f] [--no-dependencies] [--no-hooks] [--regression-test] [-o <value>] [-l
    NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg] [--turbo]

ARGUMENTS
  PACKAGES...  package(s) to deploy

FLAGS
  -f, --force                force deploy even if already installed
  -l, --test-level=<option>  deployment test level
                             <options: NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg>
  -o, --target-org=<value>   [env: SF_TARGET_ORG] target org username
      --json                 output result as JSON
      --log-level=<option>   [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                             <options: trace|debug|info|warn|error>
      --no-dependencies      only deploy the specified packages, skip transitive dependencies
      --no-hooks             skip lifecycle hooks
      --plain                non-interactive output (no spinners or cursor movement)
      --regression-test      run tests in direct dependents after deploy to detect regressions
      --turbo                single-package mode for external orchestrators (implies --no-dependencies --force)

DESCRIPTION
  deploy one or more packages from built artifacts using source-deploy

EXAMPLES
  $ sfpm deploy artifact my-package -o my-sandbox

  $ sfpm deploy artifact my-package -o my-sandbox --plain

  $ sfpm deploy artifact my-package -o my-sandbox --json

  $ sfpm deploy artifact package-a package-b -o my-sandbox
```

_See code: [dist/commands/deploy/artifact.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/deploy/artifact.js)_

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

## `sfpm install PACKAGES`

install one or more packages

```
USAGE
  $ sfpm install PACKAGES... -o <value> [--json | --plain]
    [--log-level trace|debug|info|warn|error] [-f] [-k <value>] [--no-dependencies] [--regression-test] [-l
    NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg] [--turbo]

ARGUMENTS
  PACKAGES...  package(s) to install

FLAGS
  -f, --force                     force reinstall even if already installed
  -k, --installation-key=<value>  installation key for unlocked packages
  -l, --test-level=<option>       deployment test level (for source deployments)
                                  <options: NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg>
  -o, --target-org=<value>        (required) [env: SF_TARGET_ORG] target org username
      --json                      output result as JSON
      --log-level=<option>        [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                                  <options: trace|debug|info|warn|error>
      --no-dependencies           only install the specified packages, skip transitive dependencies
      --plain                     non-interactive output (no spinners or cursor movement)
      --regression-test           run tests in direct dependents after install to detect regressions
      --turbo                     single-package mode for external orchestrators (implies --no-dependencies --force)

DESCRIPTION
  install one or more packages

EXAMPLES
  $ sfpm install my-package -o my-sandbox

  $ sfpm install my-package -o my-sandbox --plain

  $ sfpm install my-package -o my-sandbox --json

  $ sfpm install package-a package-b -o my-sandbox
```

_See code: [dist/commands/install.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/install.js)_

## `sfpm package create`

Create a new SFPM package with interactive scaffolding

```
USAGE
  $ sfpm package create [--log-level trace|debug|info|warn|error]
    [--plain | --json] [-d <value>] [-n <value>] [--org-dependent] [-p <value>] [-s <value>] [-t unlocked|source|data]

FLAGS
  -d, --devhub=<value>      DevHub org username (required for unlocked packages)
  -n, --name=<value>        package name (without npm scope)
  -p, --path=<value>        SF source path within the package directory (default: ".")
  -s, --scope=<value>       npm scope for the package (e.g., "@myorg")
  -t, --type=<option>       package type
                            <options: unlocked|source|data>
      --json                output as JSON for CI/CD
      --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                            <options: trace|debug|info|warn|error>
      --org-dependent       create as org-dependent unlocked package
      --plain               non-interactive output (no spinners or cursor movement)

DESCRIPTION
  Create a new SFPM package with interactive scaffolding

EXAMPLES
  $ sfpm package create

  $ sfpm package create --name my-package --type unlocked --devhub my-devhub

  $ sfpm package create --name my-package --type source

  $ sfpm package create --json
```

_See code: [dist/commands/package/create.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/package/create.js)_

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

## `sfpm pool delete`

delete orgs from a pool

```
USAGE
  $ sfpm pool delete -t <value> [--json | --plain] [--log-level
    trace|debug|info|warn|error] [--in-progress-only] [--my-pool] [-v <value>] [--type scratch|sandbox]

FLAGS
  -t, --tag=<value>             (required) pool tag to delete from
  -v, --target-dev-hub=<value>  [default: dev-niko] target hub org username or alias
      --in-progress-only        only delete orgs with "In Progress" status
      --json                    output result as JSON
      --log-level=<option>      [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                                <options: trace|debug|info|warn|error>
      --my-pool                 only delete orgs created by the current user
      --plain                   non-interactive output (no spinners or cursor movement)
      --type=<option>           [default: scratch] pool type: scratch or sandbox
                                <options: scratch|sandbox>

DESCRIPTION
  delete orgs from a pool

EXAMPLES
  $ sfpm pool delete --tag dev-pool -v my-devhub

  $ sfpm pool delete --tag sb-pool --type sandbox -v my-prod-org

  $ sfpm pool delete --tag dev-pool -v my-devhub --in-progress-only

  $ sfpm pool delete --tag dev-pool -v my-devhub --my-pool

  $ sfpm pool delete --tag dev-pool -v my-devhub --json
```

_See code: [dist/commands/pool/delete.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/pool/delete.js)_

## `sfpm pool fetch`

fetch an org from a pool

```
USAGE
  $ sfpm pool fetch -t <value> [--json | --plain] [--log-level
    trace|debug|info|warn|error] [-a <value>] [--limit <value>] [--my-pool] [--send-to <value>] [--source-tracking] [-v
    <value>] [--type scratch|sandbox]

FLAGS
  -a, --alias=<value>           set a local alias for the fetched org
  -t, --tag=<value>             (required) pool tag to fetch from
  -v, --target-dev-hub=<value>  [default: dev-niko] target hub org username or alias
      --json                    output result as JSON
      --limit=<value>           max orgs to return when using --all
      --log-level=<option>      [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                                <options: trace|debug|info|warn|error>
      --my-pool                 only fetch from orgs created by the current user
      --plain                   non-interactive output (no spinners or cursor movement)
      --send-to=<value>         email org details to this address instead of local login
      --source-tracking         enable source tracking after fetch
      --type=<option>           [default: scratch] pool type: scratch or sandbox
                                <options: scratch|sandbox>

DESCRIPTION
  fetch an org from a pool

EXAMPLES
  $ sfpm pool fetch --tag dev-pool -v my-devhub

  $ sfpm pool fetch --tag dev-pool -v my-devhub --alias my-scratch

  $ sfpm pool fetch --tag sb-pool --type sandbox -v my-prod-org

  $ sfpm pool fetch --tag dev-pool -v my-devhub --send-to user@example.com

  $ sfpm pool fetch --tag dev-pool -v my-devhub --all --limit 5

  $ sfpm pool fetch --tag dev-pool -v my-devhub --json
```

_See code: [dist/commands/pool/fetch.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/pool/fetch.js)_

## `sfpm pool fill`

fill a pool with orgs

```
USAGE
  $ sfpm pool fill -t <value> [--json | --plain] [--log-level
    trace|debug|info|warn|error] [--batch-size <value>] [-d <value>] [--expiry-days <value>] [--max <value>]
    [--name-pattern <value>] [-v <value>] [--type scratch|sandbox] [--use-local-source]

FLAGS
  -d, --definition-file=<value>  org definition file (scratch org or sandbox)
  -t, --tag=<value>              (required) pool tag
  -v, --target-dev-hub=<value>   [default: dev-niko] target hub org username or alias
      --batch-size=<value>       max concurrent org creations (default: 5)
      --expiry-days=<value>      scratch org expiry in days (default: 7)
      --json                     output result as JSON
      --log-level=<option>       [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                                 <options: trace|debug|info|warn|error>
      --max=<value>              maximum number of orgs to allocate (overrides config)
      --name-pattern=<value>     override sandbox name prefix from definition file (e.g., SB → SB1, SB2, ...)
      --plain                    non-interactive output (no spinners or cursor movement)
      --type=<option>            pool type: scratch or sandbox (inferred from config if omitted)
                                 <options: scratch|sandbox>
      --use-local-source         deploy from local project source instead of downloaded artifacts

DESCRIPTION
  fill a pool with orgs

EXAMPLES
  $ sfpm pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub

  $ sfpm pool fill --tag sb-pool --max 5 --type sandbox -d config/sandbox-def.json -v my-prod-org

  $ sfpm pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub --json
```

_See code: [dist/commands/pool/fill.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/pool/fill.js)_

## `sfpm pool list`

list orgs in a pool

```
USAGE
  $ sfpm pool list [--json | --plain] [--log-level
    trace|debug|info|warn|error] [--my-pool] [-t <value>] [-v <value>] [--type scratch|sandbox]

FLAGS
  -t, --tag=<value>             pool tag to query (omit to list all pools)
  -v, --target-dev-hub=<value>  [default: dev-niko] target hub org username or alias
      --json                    output result as JSON
      --log-level=<option>      [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                                <options: trace|debug|info|warn|error>
      --my-pool                 only show orgs created by the current user
      --plain                   non-interactive output (no spinners or cursor movement)
      --type=<option>           [default: scratch] pool type: scratch or sandbox
                                <options: scratch|sandbox>

DESCRIPTION
  list orgs in a pool

EXAMPLES
  $ sfpm pool list --tag dev-pool -v my-devhub

  $ sfpm pool list --tag sb-pool --type sandbox -v my-prod-org

  $ sfpm pool list --tag dev-pool -v my-devhub --my-pool

  $ sfpm pool list --tag dev-pool -v my-devhub --json
```

_See code: [dist/commands/pool/list.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/pool/list.js)_

## `sfpm project`

Overview of the project

```
USAGE
  $ sfpm project [--json | --plain] [--log-level
    trace|debug|info|warn|error] [-p]

FLAGS
  -p, --path                Display package paths
      --json                output result as JSON
      --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                            <options: trace|debug|info|warn|error>
      --plain               non-interactive output (no spinners or cursor movement)

DESCRIPTION
  Overview of the project

EXAMPLES
  $ sfpm project
```

_See code: [dist/commands/project/index.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/project/index.js)_

## `sfpm project init`

Verify project configuration and setup requirements

```
USAGE
  $ sfpm project init [--json | --plain] [--log-level
    trace|debug|info|warn|error] [-f]

FLAGS
  -f, --fix                 Attempt to fix issues automatically
      --json                output result as JSON
      --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                            <options: trace|debug|info|warn|error>
      --plain               non-interactive output (no spinners or cursor movement)

DESCRIPTION
  Verify project configuration and setup requirements

EXAMPLES
  $ sfpm project init

  $ sfpm project init --fix
```

_See code: [dist/commands/project/init/index.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/project/init/index.js)_

## `sfpm project init turbo`

Initialize a turbo-native workspace for SFPM packages

```
USAGE
  $ sfpm project init turbo [--log-level trace|debug|info|warn|error]
    [--plain | --json] [-m] [--npm-scope <value>] [--package-manager pnpm|npm|yarn] [--workspace-dir <value>] [-y]

FLAGS
  -m, --migrate                   migrate from an existing sfdx-project.json
  -y, --yes                       skip confirmation prompts (use defaults)
      --json                      output result as JSON
      --log-level=<option>        [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                                  <options: trace|debug|info|warn|error>
      --npm-scope=<value>         npm scope for package names (e.g., @myorg)
      --package-manager=<option>  [default: pnpm] package manager to use
                                  <options: pnpm|npm|yarn>
      --plain                     non-interactive output (no spinners or cursor movement)
      --workspace-dir=<value>     directory prefix for migrated packages (e.g., "packages")

DESCRIPTION
  Initialize a turbo-native workspace for SFPM packages

EXAMPLES
  $ sfpm project init turbo

  $ sfpm project init turbo --migrate

  $ sfpm project init turbo --migrate --npm-scope @myorg

  $ sfpm project init turbo --migrate --workspace-dir packages

  $ sfpm project init turbo --json
```

_See code: [dist/commands/project/init/turbo.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/project/init/turbo.js)_

## `sfpm project sync`

Generate sfdx-project.json from workspace package.json files

```
USAGE
  $ sfpm project sync [--log-level trace|debug|info|warn|error]
    [--plain | --json] [--api-version <value>]

FLAGS
  --api-version=<value>  Override Salesforce API version (e.g., 63.0)
  --json                 output result as JSON
  --log-level=<option>   [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                         <options: trace|debug|info|warn|error>
  --plain                non-interactive output (no spinners or cursor movement)

DESCRIPTION
  Generate sfdx-project.json from workspace package.json files

EXAMPLES
  $ sfpm project sync

  $ sfpm project sync --api-version 63.0
```

_See code: [dist/commands/project/sync.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/project/sync.js)_

## `sfpm project version bump`

Bump package versions in sfdx-project.json

```
USAGE
  $ sfpm project version bump [--json | --plain] [--log-level
    trace|debug|info|warn|error] [-a] [--dryrun] [-M] [-m] [-p <value>] [--patch] [-f <value>] [-o <value>] [-r <value>]
    [-v <value>]

FLAGS
  -M, --major                  Increment major number
  -a, --all                    Increment all package versions
  -f, --projectfile=<value>    [default: sfdx-project.json] Path to sfdx-project.json file
  -m, --minor                  Increment minor number
  -o, --targetorg=<value>      Specify the target org for diff comparison
  -p, --package=<value>        Specify the package to increment
  -r, --targetref=<value>      Specify the git reference for diff comparison
  -v, --versionnumber=<value>  Set a custom version number
      --dryrun                 Preview changes without saving to sfdx-project.json
      --json                   output result as JSON
      --log-level=<option>     [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                               <options: trace|debug|info|warn|error>
      --patch                  Increment patch number (default)
      --plain                  non-interactive output (no spinners or cursor movement)

DESCRIPTION
  Bump package versions in sfdx-project.json

EXAMPLES
  $ sfp project version bump --package mypackage --minor

  $ sfp project version bump --all --patch

  $ sfp project version bump --targetref main

  $ sfp project version bump --targetorg myorg

  $ sfp project version bump --package mypackage --versionnumber 2.0.0

  $ sfp project version bump --package mypackage --patch --projectfile path/to/sfdx-project.json
```

_See code: [dist/commands/project/version/bump.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/project/version/bump.js)_

## `sfpm publish [PACKAGES]`

publish one or more packages from their dist directories

```
USAGE
  $ sfpm publish [PACKAGES...] [--json | --plain]
    [--log-level trace|debug|info|warn|error] [--dry-run] [--tag <value>]

ARGUMENTS
  [PACKAGES...]  package(s) to publish (defaults to all workspace packages)

FLAGS
  --dry-run             show what would be published without actually publishing
  --json                output result as JSON
  --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                        <options: trace|debug|info|warn|error>
  --plain               non-interactive output (no spinners or cursor movement)
  --tag=<value>         [default: latest] npm dist-tag (e.g., latest, next)

DESCRIPTION
  publish one or more packages from their dist directories

EXAMPLES
  $ sfpm publish my-package

  $ sfpm publish my-package --tag next

  $ sfpm publish all
```

_See code: [dist/commands/publish.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/publish.js)_

## `sfpm watch cancel ID`

cancel a running watcher by killing its process

```
USAGE
  $ sfpm watch cancel ID [--log-level trace|debug|info|warn|error]
    [--plain | --json]

ARGUMENTS
  ID  watcher ID to cancel

FLAGS
  --json                output as JSON
  --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                        <options: trace|debug|info|warn|error>
  --plain               non-interactive output (no spinners or cursor movement)

DESCRIPTION
  cancel a running watcher by killing its process

EXAMPLES
  $ sfpm watch cancel 1234567890-abc123
```

_See code: [dist/commands/watch/cancel.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/watch/cancel.js)_

## `sfpm watch clean`

remove completed, errored, and orphaned watcher state files

```
USAGE
  $ sfpm watch clean [--log-level trace|debug|info|warn|error]
    [--plain | --json] [--type build|deploy|test]

FLAGS
  --json                output as JSON
  --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                        <options: trace|debug|info|warn|error>
  --plain               non-interactive output (no spinners or cursor movement)
  --type=<option>       only clean watchers of this type
                        <options: build|deploy|test>

DESCRIPTION
  remove completed, errored, and orphaned watcher state files

EXAMPLES
  $ sfpm watch clean

  $ sfpm watch clean --type build

  $ sfpm watch clean --json
```

_See code: [dist/commands/watch/clean.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/watch/clean.js)_

## `sfpm watch status`

check the status of async watcher jobs

```
USAGE
  $ sfpm watch status [--log-level trace|debug|info|warn|error]
    [--plain | --json] [--poll] [--type build|deploy|test]

FLAGS
  --json                output as JSON
  --log-level=<option>  [default: error, env: SFPM_LOG_LEVEL] diagnostic log level
                        <options: trace|debug|info|warn|error>
  --plain               non-interactive output (no spinners or cursor movement)
  --poll                poll Salesforce directly for current status
  --type=<option>       filter by job type (build, deploy, test)
                        <options: build|deploy|test>

DESCRIPTION
  check the status of async watcher jobs

EXAMPLES
  $ sfpm watch status

  $ sfpm watch status --type build

  $ sfpm watch status --poll

  $ sfpm watch status --json
```

_See code: [dist/commands/watch/status.js](https://github.com/b64hub/sfpm/blob/v0.1.0/dist/commands/watch/status.js)_
<!-- commandsstop -->
