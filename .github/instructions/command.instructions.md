---
description: Command output style and JSON support for the CLI package commands
applyTo: 'packages/cli/src/**/*.ts'
---

## Command Base Class

All SFPM commands should extend `SfpmCommand` instead of `@oclif/core`'s `Command`.

### Benefits of SfpmCommand

1. **Automatic Header**: Displays branded header box with version info (suppressed in JSON mode)
2. **Consistent Flow**: Implements a standard `run() → execute()` pattern
3. **JSON Mode Detection**: Built-in `jsonEnabled()` check for conditional rendering

### Usage Pattern

```typescript
import SfpmCommand from '../sfpm-command.js'

export default class MyCommand extends SfpmCommand {
  static override description = 'Command description'
  
  static override flags = {
    json: Flags.boolean({ description: 'output as JSON' }),
    quiet: Flags.boolean({ char: 'q', description: 'only show errors' }),
  }

  public async execute(): Promise<void> {
    // Your command implementation
    // Header is automatically shown (unless --json)
  }
}
```

### Don't Override run()

The `run()` method is already implemented in `SfpmCommand` to:
1. Parse flags
2. Show header (if not JSON mode)
3. Call your `execute()` method

**Always implement `execute()` instead of `run()`.**

## Output Style

### General Principles

- **No emojis** - Keep output professional and CI/CD friendly
- **Concise language** - Clear and to the point
- **Color for meaning** - Use colors semantically (red=error, yellow=warning, green=success, cyan=emphasis)
- **Consistent spacing** - Maintain visual rhythm with blank lines

### UI Elements

Use these libraries for consistent styling:

- **Spinners**: `ora` - For long-running operations
- **Text coloring**: `chalk` - For semantic colors
- **Boxes**: `boxen` - For important information or summaries

### Output Modes

Commands should support three output modes:

1. **Interactive** (default) - Full UI with spinners, colors, boxes
2. **Quiet** (`--quiet` flag) - Only errors and final results
3. **JSON** (`--json` flag) - Structured JSON output for CI/CD

```typescript
// Determine output mode in your command
const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';
```

### Do's and Don'ts

**DO:**
```typescript
// ✅ Use semantic colors
this.log(chalk.green('✓ Build complete!'))
this.log(chalk.yellow('⚠ Warning: No tests found'))
this.log(chalk.red('✗ Build failed'))

// ✅ Use spinners for long operations
const spinner = ora('Building package...').start()
// ... operation ...
spinner.succeed('Package built successfully')

// ✅ Use boxes for summaries (with center-aligned titles)
const summary = boxen(
  `Package: ${packageName}\nVersion: ${version}`,
  { 
    padding: 1, 
    borderColor: 'cyan',
    title: 'Build Summary',
    titleAlignment: 'center'
  }
)
this.log(summary)

// ✅ Respect output mode
if (mode === 'interactive') {
  this.log(chalk.dim('Processing...'))
}
```

**DON'T:**
```typescript
// ❌ Don't use emojis excessively
this.log('🎉 Build complete! 🚀')

// ❌ Don't output to console directly
console.log('Building...') // Use this.log() instead

// ❌ Don't ignore JSON mode
this.log('Building...') // Check mode first

// ❌ Don't mix output streams inconsistently
console.error('Error') // Use this.error() instead
```

## Event-Driven UI Rendering

SFPM uses an **event-driven architecture** for clean separation between business logic (core) and UI (CLI).

### Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│   Command   │ creates │  Core Service    │ emits   │  Renderer   │
│   (CLI)     │────────>│ (PackageBuilder) │────────>│  (UI Logic) │
└─────────────┘         └──────────────────┘         └─────────────┘
                               │                              │
                               │ EventEmitter                 │
                               └──────────────────────────────┘
```

### Core Services Emit Events

Core services like `PackageBuilder` and `PackageInstaller` extend `EventEmitter` and emit namespaced events:

```typescript
// In PackageBuilder (core)
this.emit('build:start', {
  timestamp: new Date(),
  packageName: this.packageName,
  packageType: this.package.packageType,
})

this.emit('stage:start', { timestamp: new Date() })
this.emit('stage:complete', { 
  timestamp: new Date(),
  componentCount: 42 
})

this.emit('build:complete', {
  timestamp: new Date(),
  packageVersionId: '04t...',
})
```

### Renderers Listen and Render

CLI commands create **renderer classes** that:
1. Subscribe to core service events
2. Manage UI state (spinners, timing, formatting)
3. Render progress based on output mode
4. Collect events for JSON output

```typescript
// In BuildProgressRenderer
export class BuildProgressRenderer {
  private spinner?: Ora
  private events: EventLog[] = []
  private mode: OutputMode

  public attachTo(builder: PackageBuilder): void {
    builder.on('build:start', this.handleBuildStart.bind(this))
    builder.on('stage:start', this.handleStageStart.bind(this))
    builder.on('stage:complete', this.handleStageComplete.bind(this))
    // ... more events
  }

  private handleStageStart(event: StageStartEvent): void {
    this.logEvent('stage:start', event) // For JSON mode
    
    if (this.mode === 'interactive') {
      this.spinner = ora('Staging package').start()
    }
  }

  private handleStageComplete(event: StageCompleteEvent): void {
    this.logEvent('stage:complete', event)
    
    if (this.mode === 'interactive') {
      this.spinner?.succeed(`Staged ${event.componentCount} components`)
    }
  }
}
```

### Command Integration Pattern

Commands wire up the renderer to the service:

```typescript
export default class Build extends SfpmCommand {
  public async execute(): Promise<void> {
    const { flags } = await this.parse(Build)
    
    // 1. Determine output mode
    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive'
    
    // 2. Create core service
    const builder = new PackageBuilder(config, options, logger)
    
    // 3. Create and attach renderer
    const renderer = new BuildProgressRenderer({
      logger: {
        log: (msg: string) => this.log(msg),
        error: (msg: string | Error) => this.error(msg),
      },
      mode,
    })
    renderer.attachTo(builder)
    
    // 4. Execute (renderer handles all output)
    try {
      await builder.buildPackage(packageName)
      
      if (flags.json) {
        this.logJson(renderer.getJsonOutput())
      }
    } catch (error) {
      renderer.handleError(error as Error)
      
      if (flags.json) {
        this.logJson(renderer.getJsonOutput())
      }
      
      throw error
    }
  }
}
```

### Event Naming Convention

Events use namespaced names: `<domain>:<action>`

**Common patterns:**
- `build:start`, `build:complete`, `build:error`, `build:skipped`
- `install:start`, `install:complete`, `install:error`
- `stage:start`, `stage:complete`
- `analyzer:start`, `analyzer:complete`
- `deployment:start`, `deployment:progress`, `deployment:complete`

### Benefits of Event-Driven UI

1. **Separation of Concerns**: Business logic in core, UI logic in CLI
2. **Testability**: Core can be tested without UI dependencies
3. **Flexibility**: Multiple renderers possible (interactive, quiet, JSON, future TUI)
4. **Reusability**: Core services work in any context (CLI, API, scripts)
5. **Progress Tracking**: Fine-grained control over what's displayed when

## JSON Support

All central commands should support JSON output via `--json` flag.

### What Requires JSON Support

- ✅ `build` - Package building
- ✅ `install` - Package installation
- ✅ Future: `test`, `deploy`, `publish`

### What Doesn't Require JSON Support

- ❌ `init` - Interactive setup
- ❌ `project` - Visual tree display
- ❌ `hello` - Example commands

### JSON Output Structure

```typescript
interface JsonOutput {
  success: boolean
  data?: {
    packageName: string
    packageVersion?: string
    packageVersionId?: string
    duration?: number
    // ... command-specific data
  }
  error?: {
    message: string
    name: string
    code?: string
    context?: Record<string, any>
  }
  events?: Array<{
    type: string
    timestamp: Date
    data: any
  }>
}
```

### Implementing JSON Support

```typescript
// In renderer class
export class BuildProgressRenderer {
  private events: EventLog[] = []
  private buildResult?: { success: boolean; ... }

  private logEvent(type: string, data: any): void {
    this.events.push({
      type,
      timestamp: new Date(),
      data,
    })
  }

  public getJsonOutput(): JsonOutput {
    return {
      success: this.buildResult?.success ?? false,
      data: {
        packageName: this.packageName,
        packageVersionId: this.buildResult?.packageVersionId,
      },
      error: this.buildResult?.error ? {
        message: this.buildResult.error.message,
        name: this.buildResult.error.name,
      } : undefined,
      events: this.events,
    }
  }
}
```

## Command Overview

### Core Commands (JSON-enabled)

#### `build <packages>`
**Responsibility**: Build packages into versioned artifacts
- Creates unlocked package versions (via Salesforce)
- Assembles source packages into artifacts
- Generates artifact metadata and manifests
- **Events**: `build:*`, `stage:*`, `analyzer:*`, `unlocked:create:*`, `task:*`
- **Renderer**: `BuildProgressRenderer`

#### `install <packages>`
**Responsibility**: Install packages to target orgs
- Installs from artifacts (version install) or source (deployment)
- Handles dependencies
- Supports multiple installation strategies
- **Events**: `install:*`, `connection:*`, `deployment:*`, `version-install:*`
- **Renderer**: `InstallProgressRenderer`

### Utility Commands (No JSON)

#### `init`
**Responsibility**: Verify and fix project configuration
- Checks sfdx-project.json existence
- Validates Git repository setup
- Verifies package directories
- Can auto-fix issues with `--fix`
- **Output**: Checklist with ✓/✗ indicators

#### `project`
**Responsibility**: Display project structure and dependencies
- Shows package dependency tree
- Displays package types and paths
- Visual tree representation with `object-treeify`
- **Output**: ASCII tree with colored legend

#### `project version bump`
**Responsibility**: Bump package version numbers
- Increments major/minor/patch versions
- Updates sfdx-project.json
- Respects package type version formats
- **Output**: Version change summary

### Example Commands (Keep for reference)

#### `hello` and `hello world`
**Responsibility**: oclif examples
- Not extended from SfpmCommand
- Demonstrate basic oclif patterns
- Can be removed in production

## Testing Commands

See [testing.instructions.md](./testing.instructions.md) for full testing patterns.

### Command Testing Pattern

```typescript
describe('Build Command', () => {
  it('should build package with correct flags', async () => {
    // Mock core services
    vi.mock('@b64/sfpm-core', () => ({
      PackageBuilder: vi.fn(() => ({
        buildPackage: vi.fn(),
        on: vi.fn(),
      })),
    }))

    const result = await Build.run(['my-package', '-v', 'devhub'])
    expect(result).toBeDefined()
  })
})
```  
