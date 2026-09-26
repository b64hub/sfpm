#!/usr/bin/env node
/**
 * Smoke test for the bundled GitHub Actions.
 *
 * For each of the 8 action bundle entries, runs the bundled .mjs file in a
 * temp directory with minimal required inputs, expecting it to fail with a
 * domain-level error (e.g., missing workspace packages, auth failure) rather
 * than a module-resolution, Messages-loading, or pino/worker error.
 *
 * Additionally checks that jiti can load a trivial sfpm.config.ts and that
 * bundled Salesforce libraries that load messages from disk are accounted for.
 *
 * Exit code: 0 if all entries pass, 1 otherwise.
 */

import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = join(repoRoot, 'packages', 'actions', 'bundle');
const actionsDir = join(repoRoot, 'packages', 'actions');

/**
 * Minimal SFDX project (sfdx-project.json + one Apex class + a trivial
 * sfpm.config.ts + a workspace package.json) copied into each action's temp
 * directory before it runs. Without this, every action fails at the very
 * first step ("does not contain a valid Salesforce DX project", from
 * @salesforce/core's own SfProject.resolve()) and none of jiti's config
 * loading or @salesforce/packaging's runtime code ever executes — so the
 * one runtime dependency the bundle ships shims for (packaging's messages/)
 * was never actually exercised. Seeding this fixture lets each action reach
 * a deeper, more meaningful domain error instead (see each ACTION_CONFIG
 * entry's comment for what that deeper error proves).
 */
const fixtureDir = join(repoRoot, 'scripts', 'fixtures', 'smoke-project');

/**
 * Per-action configuration: required inputs and expected domain error regex.
 * Keyed by action directory name.
 */
const ACTION_CONFIG = {
  'build': {
    required: [],
    // With the fixture project present, the build actually stages the
    // package and calls into @salesforce/packaging to create a package
    // version, which needs a connected DevHub. Reaching this error (instead
    // of "not a valid SFDX project") proves project loading AND packaging's
    // own runtime code (including its on-disk messages/ loading) both ran.
    expect: /Must run connect\(\) before exec\(\)/,
  },
  'build-turbo-aggregate': {
    required: [],
    // This action aggregates a prior `turbo run --summarize` output; it
    // doesn't call packaging. Reaching this error (instead of "not a valid
    // SFDX project") proves project loading got past the initial check and
    // the action moved on to looking for turbo's run summary.
    expect: /No turbo run summary found/,
  },
  'build-validation': {
    required: ['build-result'],
    // build-result input name has hyphen, becomes INPUT_BUILD-RESULT env var.
    // A well-formed (not empty-object) build-result is required here: an
    // empty `{}` crashes with a bare TypeError (`state.packages` is
    // undefined) before any real validation-resolution code runs, which is
    // exactly the kind of infrastructure-looking failure this test must not
    // let pass.
    buildResultValue: JSON.stringify({
      packages: [{
        packageName: 'test-pkg',
        pendingValidation: {
          operationType: 'package-version-request',
          packageName: 'test-pkg',
          packageVersionRequestId: '09Sxxxxxxxxxxxxxxx',
          devhub: 'placeholder-dh-user',
        },
      }],
    }),
    // Reaching a per-package validation failure (rather than "not a valid
    // SFDX project") proves project loading and the ValidationResolver's own
    // code path both ran.
    expect: /Validation failed for: test-pkg/,
  },
  'clean-pool': {
    required: ['devhub-username', 'pool-tag'],
    // Doesn't touch the project directory at all (pool orgs are looked up by
    // tag against the DevHub) — the fixture makes no difference here, but is
    // seeded anyway for consistency. Reaching a DevHub-auth error proves the
    // action's own connection code ran.
    expect: /No authorization information found/,
  },
  'deploy': {
    required: ['target-org', 'packages'],
    // Resolves `packages` from the npm registry regardless of the local
    // project contents, so the fixture doesn't change this action's error;
    // seeded anyway for consistency.
    expect: /npm error 404|not found in the npm registry/i,
  },
  'fill-pool': {
    required: ['devhub-username', 'pool-tag'],
    // With the fixture's sfpm.config.ts present, this action logs "Loaded
    // SFPM config with 0 hook set(s)" before connecting to the DevHub —
    // proof that jiti loaded the config through the bundle's own resolution
    // — then reaches the same DevHub-auth error as without the fixture.
    expect: /No authorization information found/,
  },
  'install': {
    required: ['target-org', 'packages'],
    // Resolves `packages` from the npm registry regardless of the local
    // project contents; seeded anyway for consistency.
    expect: /npm error 404|not found in the npm registry/i,
  },
  'validate-pr': {
    required: [],
    // Needs a `pull_request` GitHub event payload, which nothing in the local
    // project fixture can provide, so the fixture doesn't change this
    // action's error; seeded anyway for consistency.
    expect: /Could not determine PR number/,
  },
};

/**
 * Scan packages/actions for action directories and derive ACTIONS list from action.yml.
 * Returns array of {name, entry, entryPath, required, expect}.
 */
function discoverActions() {
  const yaml = require(require.resolve('yaml', {paths: [actionsDir]}));
  const actions = [];

  const actionDirs = readdirSync(actionsDir)
    .filter(d => {
      try {
        return statSync(join(actionsDir, d)).isDirectory() &&
               existsSync(join(actionsDir, d, 'action.yml'));
      } catch {
        return false;
      }
    })
    .sort();

  for (const dir of actionDirs) {
    const actionYmlPath = join(actionsDir, dir, 'action.yml');
    const manifest = yaml.parse(readFileSync(actionYmlPath, 'utf8'));

    if (!manifest.runs || !manifest.runs.main) {
      console.error(`${dir}: no runs.main found in action.yml`);
      continue;
    }

    // Resolve runs.main relative to the action directory
    const entryPath = resolve(join(actionsDir, dir), manifest.runs.main);
    if (!existsSync(entryPath)) {
      console.error(`${dir}: resolved entry not found: ${entryPath}`);
      continue;
    }

    const config = ACTION_CONFIG[dir];
    if (!config) {
      throw new Error(`No ACTION_CONFIG entry for discovered action: ${dir}`);
    }

    // Extract the entry filename from runs.main for reporting
    const entry = manifest.runs.main.split('/').pop();

    actions.push({
      name: dir,
      entry,
      entryPath,
      required: config.required,
      expect: config.expect,
      buildResultValue: config.buildResultValue,
    });
  }

  return actions;
}

const ACTIONS = discoverActions();

/**
 * Libraries to check for real, on-disk message loading at runtime.
 *
 * The only pattern that actually reads a message bundle from disk at
 * runtime is `<Messages>.importMessagesDirectory(__dirname)` (or an
 * equivalent real directory argument) immediately followed by
 * `.loadMessages(pkg, file)` calls, at real call sites in the package's
 * OWN compiled `lib/**` code. Matching bare `Messages.importMessagesDirectory`
 * or `Messages.loadMessages` text anywhere is not enough: `@salesforce/core`
 * ships a docstring example of the same API in comments, and an unused,
 * never-imported build-time codemod tool (`lib/messageTransformer.js`) that
 * also mentions it — neither is a real runtime call. Core's own messages are
 * pre-inlined as literal `new Messages(pkg, bundle, new Map([...]))` calls at
 * Salesforce's own publish time, so core never reads a `messages/` directory
 * from disk at runtime. Exclude comment lines and known non-runtime files so
 * this check doesn't cry wolf.
 *
 * Patterns checked: importMessagesDirectory (CJS/ESM direct), importMessagesDirectoryFromMetaUrl (ESM via import.meta.url),
 * and importMessageFile (ESM alternate API).
 */
const MESSAGES_PATTERNS = [
  /\.importMessagesDirectory\(\s*(?:__dirname|path\.dirname\()/,
  /\.importMessagesDirectoryFromMetaUrl\(/,
  /\.importMessageFile\(/,
];
const MESSAGES_LIBRARIES = [
  '@salesforce/packaging',
  '@salesforce/source-deploy-retrieve',
  '@salesforce/core',
  '@salesforce/apex-node',
];

const results = [];
let hasMessageFailures = false;
const messageFailureReasons = [];

// ============================================================================
// Test each action entry
// ============================================================================

console.log('Starting smoke test for bundled GitHub Actions...\n');

for (const action of ACTIONS) {
  // Create a temp directory for this action's run, seeded with the minimal
  // SFDX project fixture so actions get past initial project loading.
  const tempDir = mkdtempSync(join(tmpdir(), 'sfpm-smoke-'));
  cpSync(fixtureDir, tempDir, {recursive: true});

  try {
    // Create temp files for @actions/core output.
    const outputFile = join(tempDir, '.github-output');
    const stateFile = join(tempDir, '.github-state');
    writeFileSync(outputFile, '');
    writeFileSync(stateFile, '');

    // Build env vars: copy current env, set required inputs, set action core env vars.
    const env = {
      ...process.env,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STATE: stateFile,
      GITHUB_WORKSPACE: tempDir,
    };

    // Add minimal required inputs.
    for (const inputName of action.required) {
      // @actions/core converts input name: spaces -> underscores, hyphens preserved
      const envName = `INPUT_${inputName.replace(/ /g, '_').toUpperCase()}`;
      
      if (inputName === 'devhub-username') env[envName] = 'placeholder-dh-user';
      else if (inputName === 'pool-tag') env[envName] = 'placeholder-pool';
      else if (inputName === 'target-org') env[envName] = 'placeholder-target';
      else if (inputName === 'packages') env[envName] = 'placeholder-pkg';
      else if (inputName === 'build-result') {
        // Use well-formed build-result with proper structure
        env[envName] = action.buildResultValue || '{"packages":[]}';
      } else {
        env[envName] = `placeholder-${inputName}`;
      }
    }

    // Run the action entry.
    const result = spawnSync('node', [action.entryPath], {
      cwd: tempDir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000, // 30s timeout per action
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const combined = stdout + '\n' + stderr;

    // Check for infrastructure/module errors (bad patterns).
    const badPatterns = [
      /ERR_MODULE_NOT_FOUND/,
      /Cannot find module/i,
      /cannot find|no such/i,
      /messages?.*(?:missing|cannot find|no such|not found)/i,
      /(?:missing|cannot find|no such|not found).*messages?/i,
      /worker.*ERR_|ERR_.*worker/i,
      /Bare specifier/i,
    ];

    let hasBadError = false;
    for (const pattern of badPatterns) {
      if (pattern.test(combined)) {
        hasBadError = true;
        results.push({
          name: action.name,
          status: 'FAIL',
          reason: `Infrastructure error (pattern: ${pattern}): ${combined.slice(0, 150)}`,
        });
        break;
      }
    }

    if (!hasBadError) {
      // Task 3.1: Check if the expect regex matches the output
      if (action.expect.test(combined)) {
        results.push({
          name: action.name,
          status: 'PASS',
          exitCode: result.status,
          reason: `Domain error (exit ${result.status})`,
        });
      } else {
        results.push({
          name: action.name,
          status: 'FAIL',
          reason: `Expected error pattern not found. Got: ${combined.slice(0, 200)}`,
        });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      name: action.name,
      status: 'FAIL',
      reason: `Exception during test: ${msg}`,
    });
  } finally {
    // Clean up temp directory.
    rmSync(tempDir, {recursive: true, force: true});
  }
}

// ============================================================================
// Check Messages loading: find which Salesforce libraries call Messages.* on disk
// ============================================================================

console.log('\nChecking Messages-loading patterns in bundled libraries...\n');

const messagesFindings = [];

/**
 * Search a directory recursively for a real (non-comment) call matching any
 * of the message patterns, skipping known non-runtime files. Returns true on the first hit.
 */
function searchForRealMessageCall(dir, patterns, ext = /\.(js|cjs)$/) {
  try {
    for (const item of readdirSync(dir)) {
      const fullPath = join(dir, item);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !item.includes('node_modules')) {
        if (searchForRealMessageCall(fullPath, patterns, ext)) return true;
      } else if (
        stat.isFile()
        && ext.test(item)
        // messages.js defines the shared Messages class API (every library's
        // Messages come from @salesforce/core's own messages.js) — matching
        // text there is the method DEFINITION, not a library calling it on
        // itself. messageTransformer.js is a build-time codemod tool, never
        // imported at runtime. Both would false-positive every library.
        && item !== 'messageTransformer.js'
        && item !== 'messages.js'
      ) {
        try {
          const lines = readFileSync(fullPath, 'utf8').split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            // Skip comment lines (docstring examples aren't real calls).
            if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
            for (const pattern of patterns) {
              if (pattern.test(line)) return true;
            }
          }
        } catch {
          // Skip unreadable files.
        }
      }
    }
  } catch {
    // Ignore directory read errors.
  }
  return false;
}

/**
 * Task 3.4: Derive the set of bundled library directories from the metafile
 * instead of searching by package name in the pnpm store.
 */
function getBundledLibraryDirectories() {
  const metafilePath = join(actionsDir, 'bundle-metafile.json');
  let metafile;
  try {
    metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
  } catch {
    return new Map();
  }

  const libDirs = new Map(); // libName -> Set of absolute lib/ directory paths

  if (!metafile.inputs) return libDirs;

  for (const inputPath of Object.keys(metafile.inputs)) {
    // inputPath is relative to actionsDir, e.g. '../../node_modules/.pnpm/@salesforce+core@8.31.0_.../node_modules/@salesforce/core/lib/file.js'
    const absInputPath = resolve(actionsDir, inputPath);

    for (const libName of MESSAGES_LIBRARIES) {
      // Match against the exact package name as a path segment (e.g.
      // '/@salesforce/core/'), not a substring, so 'core' can't match an
      // unrelated package name that merely contains it.
      if (absInputPath.includes(`/${libName}/`)) {
        const libDir = absInputPath.slice(0, absInputPath.indexOf('/lib/') + '/lib'.length);
        if (existsSync(libDir)) {
          if (!libDirs.has(libName)) {
            libDirs.set(libName, new Set());
          }
          libDirs.get(libName).add(libDir);
        }
      }
    }
  }

  return libDirs;
}

const bundledLibDirs = getBundledLibraryDirectories();

// Task 3.2 and 3.4: Check messages loading and fail if expectations aren't met
for (const libName of MESSAGES_LIBRARIES) {
  const libDirs = bundledLibDirs.get(libName);
  let found = false;

  if (!libDirs || libDirs.size === 0) {
    // Library not bundled; that's OK if it's not packaging
    if (libName === '@salesforce/packaging') {
      hasMessageFailures = true;
      messageFailureReasons.push(`CRITICAL: @salesforce/packaging not found in bundle, but messages/ directory is shipped. Detection may be broken.`);
    } else {
      messagesFindings.push(`${libName}: not bundled`);
    }
    continue;
  }

  // Check each bundled directory of this library
  for (const libDir of libDirs) {
    if (searchForRealMessageCall(libDir, MESSAGES_PATTERNS)) {
      found = true;
      break;
    }
  }

  if (found) {
    // Library loads messages at runtime
    if (libName === '@salesforce/packaging') {
      // This is expected and required
      messagesFindings.push(`${libName}: FOUND (real messages loading at runtime — reads messages/ from disk)`);
    } else {
      // Any OTHER library loading messages is a problem
      hasMessageFailures = true;
      messageFailureReasons.push(`${libName}: FOUND loading messages at runtime, but only @salesforce/packaging should. The shipped messages/ directory won't account for this.`);
    }
  } else {
    // Library does not load messages at runtime
    if (libName === '@salesforce/packaging') {
      hasMessageFailures = true;
      messageFailureReasons.push(`@salesforce/packaging: NOT FOUND loading messages at runtime, but messages/ directory is shipped. Something may be wrong with detection.`);
    } else {
      messagesFindings.push(`${libName}: no real on-disk messages loading at runtime (messages are pre-inlined or absent)`);
    }
  }
}

// ============================================================================
// Check jiti loading with a temporary probe file (task 7)
// ============================================================================

console.log('\nChecking jiti/sfpm.config.ts loading...\n');

let jitiTestResult = 'UNKNOWN';
const jitiTempDir = mkdtempSync(join(tmpdir(), 'sfpm-jiti-'));
const jitiProbeDir = join(bundleDir, 'chunks');
const jitiProbeFile = join(jitiProbeDir, `jiti-probe-${randomBytes(8).toString('hex')}.mjs`);

try {
  // Ensure chunks directory exists (it always does after a real build, since
  // this bundle has multiple entry points and esbuild code-splitting always
  // produces bundle/chunks/ — this is just a defensive fallback).
  mkdirSync(jitiProbeDir, {recursive: true});

  // Write a minimal sfpm.config.ts
  const configContent = 'export default {};';
  const configPath = join(jitiTempDir, 'sfpm.config.ts');
  writeFileSync(configPath, configContent);

  // Create a probe file that imports jiti as the bundled code would (via bare specifier resolution)
  // The probe lives in bundle/chunks/, so `import('jiti')` resolves to bundle/chunks/../node_modules/jiti
  const probeScript = `
import createJiti from 'jiti';

(async () => {
  try {
    const jiti = createJiti(import.meta.url, {});
    const config = await jiti.import('${configPath}');
    console.log('SUCCESS: jiti loaded config');
    process.exit(0);
  } catch (error) {
    console.error('ERROR:', error.message || error);
    process.exit(1);
  }
})();
`;

  writeFileSync(jitiProbeFile, probeScript);

  const jitiTest = spawnSync('node', [jitiProbeFile], {
    cwd: jitiProbeDir,  // Run from probe's directory so resolution works
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });

  const jitiOutput = (jitiTest.stdout || '') + '\n' + (jitiTest.stderr || '');

  if (jitiOutput.includes('SUCCESS: jiti loaded config')) {
    jitiTestResult = 'PASS (jiti successfully loaded sfpm.config.ts)';
  } else if (/ERR_|Cannot find|no such|not found/i.test(jitiOutput)) {
    jitiTestResult = 'FAIL (module/resolution error)';
  } else {
    jitiTestResult = `FAIL: unexpected output: ${jitiOutput.slice(0, 150)}`;
  }
} catch (error) {
  jitiTestResult = `FAIL: ${String(error).slice(0, 100)}`;
} finally {
  // Always clean up the probe file so it never reaches the tag commit.
  // The release workflow runs this smoke test BEFORE `git add -f packages/actions/bundle`,
  // so a leftover probe would otherwise get accidentally committed.
  try {
    rmSync(jitiProbeFile, {force: true});
  } catch {
    // Ignore cleanup errors
  }
  rmSync(jitiTempDir, {recursive: true, force: true});
}

// ============================================================================
// Summary
// ============================================================================

console.log('\n========== SMOKE TEST SUMMARY ==========\n');

for (const result of results) {
  const statusSymbol = result.status === 'PASS' ? '✓' : '✗';
  console.log(`${statusSymbol} ${result.name.padEnd(25)} ${result.status.padEnd(6)} ${result.reason}`);
}

console.log('\n--- Messages Loading ---');
for (const finding of messagesFindings) {
  console.log(`  ${finding}`);
}
for (const reason of messageFailureReasons) {
  console.log(`  ✗ ${reason}`);
}

console.log('\n--- jiti/sfpm.config.ts Loading ---');
console.log(`  ${jitiTestResult}`);

const hasFailures = results.some((r) => r.status === 'FAIL');
const hasJitiFailure = jitiTestResult.startsWith('FAIL');

if (hasFailures) {
  console.log('\n❌ SMOKE TEST FAILED: Some entries have infrastructure errors.');
  process.exitCode = 1;
} else if (hasMessageFailures) {
  console.log('\n❌ SMOKE TEST FAILED: Messages loading expectations not met.');
  process.exitCode = 1;
} else if (hasJitiFailure) {
  console.log('\n❌ SMOKE TEST FAILED: jiti loading check failed.');
  process.exitCode = 1;
} else {
  console.log('\n✅ SMOKE TEST PASSED: All entries and checks passed.');
  process.exitCode = 0;
}
