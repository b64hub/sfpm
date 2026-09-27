#!/usr/bin/env node
/**
 * Smoke test for the bundled GitHub Actions.
 *
 * Copies the real bundle to an isolated temporary directory (not the checked-out
 * `packages/actions/bundle`), then for each discovered action from
 * `scripts/lib/action-manifests.mjs`, runs the bundled entry in a temp project
 * directory seeded with a minimal fixture. Three checks run in sequence:
 *
 * 1. **Action Checks** (per-action, with parity): Run each bundled entry with
 *    domain-level inputs, capture output, and assert it fails with an expected
 *    domain error (auth failure, missing org, bad input). Also run the unbundled
 *    tsc output with the same inputs and assert the error lines match (proving
 *    bundling didn't break behavior). Env vars are allowlisted (not inherited),
 *    and each action's temp project is separate from the bundle copy.
 *
 * 2. **Messages-Loading Check**: Scan all bundled third-party packages for
 *    on-disk Messages loading at runtime (`.importMessagesDirectory`,
 *    `.importMessageFile`, etc.). Only `@salesforce/packaging` should do this.
 *    Skip known internal files (@salesforce/core's loader implementation).
 *
 * 3. **jiti Check**: Verify the bundle's jiti can load a trivial TypeScript
 *    config file (exercises dynamic loading through bundled resolution).
 *
 * Exit code: 0 if all checks pass, 1 otherwise. A missing entry, a stale
 * ACTION_CONFIG key, or any failed check sets a nonzero exit code and appears
 * in the final report.
 */

import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';

import {
  actionsDir, bundleDir, listActions, repoRoot,
} from './lib/action-manifests.mjs';
import {readTextIfExists} from './lib/fs-utils.mjs';
import {resolvePackage} from './lib/packages.mjs';

// ============================================================================
// Configuration and Constants
// ============================================================================

// Real runs finish in ~1-8s (npm/AuthInfo calls plus process startup); the
// margin above that absorbs CI-runner contention without slowing down the
// success path, since the timeout only matters when something is hanging.
const ACTION_TIMEOUT_MS = 30_000;

const fixtureDir = join(repoRoot, 'scripts', 'fixtures', 'smoke-project');

/**
 * Per-action configuration: required inputs and expected domain error regex.
 * All entries are seeded with the fixture project (sfdx-project.json + Apex
 * class + sfpm.config.ts + package.json) so each action can reach its actual
 * domain logic (project loading, jiti config loading, packaging message loading
 * for `build`, DevHub auth for pool actions) instead of failing immediately on
 * "not a valid SFDX project".
 */
const ACTION_CONFIG = {
  build: {
    expect: /Must run connect\(\) before exec\(\)/,
    required: [],
  },
  'build-turbo-aggregate': {
    expect: /No turbo run summary found/,
    required: [],
  },
  'build-validation': {
    buildResultValue: JSON.stringify({
      packages: [{
        packageName: 'test-pkg',
        pendingValidation: {
          devhub: 'placeholder-dh-user',
          operationType: 'package-version-request',
          packageName: 'test-pkg',
          packageVersionRequestId: '09Sxxxxxxxxxxxxxxx',
        },
      }],
    }),
    expect: /Validation failed for: test-pkg/,
    required: ['build-result'],
  },
  'clean-pool': {
    expect: /No authorization information found/,
    required: ['devhub-username', 'pool-tag'],
  },
  deploy: {
    // fetch-retries=0: npm's default retry/backoff on a connection error takes
    // ~80s (2 retries, exponential backoff) before surfacing ECONNREFUSED —
    // confirmed empirically. Disabling retries keeps this deterministic and
    // fast without weakening what's being proven (the registry is genuinely
    // unreachable either way).
    env: {npmConfigFetchRetries: '0', npmConfigRegistry: 'http://127.0.0.1:9'},
    expect: /ECONNREFUSED|connect ECONNREFUSED/i,
    required: ['target-org', 'packages'],
  },
  'fill-pool': {
    expect: /No authorization information found/,
    required: ['devhub-username', 'pool-tag'],
  },
  install: {
    // See the `deploy` entry above: fetch-retries=0 avoids npm's ~80s retry
    // backoff on a connection error.
    env: {npmConfigFetchRetries: '0', npmConfigRegistry: 'http://127.0.0.1:9'},
    expect: /ECONNREFUSED|connect ECONNREFUSED/i,
    required: ['target-org', 'packages'],
  },
  'validate-pr': {
    env: tempDir => ({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: join(tempDir, '.github-event.json'),
    }),
    // Reaching this (rather than "Could not determine PR number") proves PR-event
    // parsing, project loading, git diffing, and the local build/dependency-analysis
    // pipeline all ran, down to a real per-package validation failure.
    expect: /Validation failed for: smoke-test-pkg/,
    required: [],
  },
};

/**
 * Libraries that may read message bundles from disk at runtime. The only
 * legitimate consumer of a shipped `messages/` directory is @salesforce/packaging,
 * which calls `.importMessagesDirectory(__dirname)` in its compiled lib/*.js files.
 */
const MESSAGES_LIBRARIES = ['@salesforce/packaging', '@salesforce/source-deploy-retrieve', '@salesforce/core', '@salesforce/apex-node'];

/**
 * Patterns that detect on-disk Messages loading in source code. Matches bare
 * importMessagesDirectory, importMessagesDirectoryFromMetaUrl, and importMessageFile
 * calls (not docstring examples or definitions of those methods themselves).
 */
const MESSAGES_PATTERNS = [
  /\.importMessagesDirectory\(\s*(?:__dirname|path\.dirname\()/,
  /\.importMessagesDirectoryFromMetaUrl\(/,
  /\.importMessageFile\(/,
];

// Loader implementation inside @salesforce/core (the Messages class itself and
// a build-time codemod), not consumer calls. Scoped to core so a same-named
// file in another library is still scanned.
const CORE_EXCLUDED_FILES = ['messages.js', 'messageTransformer.js'];

// ============================================================================
// Phases: Action Checks, Messages Check, jiti Check
// ============================================================================

/**
 * Run each action from the isolated bundle copy with domain inputs, and also
 * run the unbundled dist entry with the same inputs, comparing error output
 * for parity. Returns [{name, ok, details}, ...].
 */
async function runActionChecks(isolatedBundleDir, actions) {
  const results = [];

  // Validate ACTION_CONFIG: every entry must have a matching discovered action.
  const actionNames = new Set(actions.map(a => a.name));
  for (const configKey of Object.keys(ACTION_CONFIG)) {
    if (!actionNames.has(configKey)) {
      results.push({
        details: `No discovered action directory for ACTION_CONFIG key "${configKey}"`,
        name: configKey,
        ok: false,
      });
    }
  }

  for (const action of actions) {
    const config = ACTION_CONFIG[action.name];
    if (!config) {
      results.push({
        details: 'No ACTION_CONFIG entry; skipping',
        name: action.name,
        ok: false,
      });
      continue;
    }

    // Create a temp project directory for this action's run, seeded with the fixture.
    const tempProjectDir = mkdtempSync(join(tmpdir(), 'sfpm-action-'));

    try {
      // Copy fixture into the action's temp directory.
      cpSync(fixtureDir, tempProjectDir, {recursive: true});

      // Initialize git repo for changed-package detection (validate-pr may need it).
      const gitInit = spawnSync('git', ['init', tempProjectDir], {
        encoding: 'utf8',
        stdio: 'ignore',
      });
      if (gitInit.status === 0) {
        spawnSync('git', ['-C', tempProjectDir, 'config', 'user.email', 'test@example.com'], {stdio: 'ignore'});
        spawnSync('git', ['-C', tempProjectDir, 'config', 'user.name', 'Test'], {stdio: 'ignore'});
        spawnSync('git', ['-C', tempProjectDir, 'add', '.'], {stdio: 'ignore'});
        spawnSync('git', ['-C', tempProjectDir, 'commit', '-m', 'Initial'], {stdio: 'ignore'});
      }

      // Create action-specific output files for @actions/core.
      const outputFile = join(tempProjectDir, '.github-output');
      const stateFile = join(tempProjectDir, '.github-state');
      writeFileSync(outputFile, '');
      writeFileSync(stateFile, '');

      // Build the allowlisted env for this action.
      const childEnv = buildChildEnv(config, tempProjectDir, outputFile, stateFile);

      // Set required inputs. @actions/core converts input name:
      // spaces -> underscores (only spaces, not hyphens), everything uppercase.
      for (const inputName of config.required) {
        const envName = `INPUT_${inputName.replaceAll(' ', '_').toUpperCase()}`;
        switch (inputName) {
        case 'build-result': {
          childEnv[envName] = config.buildResultValue || '{"packages":[]}';
          break;
        }

        case 'devhub-username': {
          childEnv[envName] = 'placeholder-dh-user';
          break;
        }

        case 'packages': {
          childEnv[envName] = '@b64hub/sfpm-smoke-does-not-exist';
          break;
        }

        case 'pool-tag': {
          childEnv[envName] = 'placeholder-pool';
          break;
        }

        case 'target-org': {
          childEnv[envName] = 'placeholder-target';
          break;
        }

        default: {
          childEnv[envName] = `placeholder-${inputName}`;
        }
        }
      }

      // Write validate-pr's GitHub event payload if needed.
      const eventPath = childEnv.GITHUB_EVENT_PATH;
      if (eventPath && action.name === 'validate-pr') {
        const eventPayload = {
          number: 99,
          // eslint-disable-next-line camelcase -- mirrors GitHub's actual webhook payload shape, which is snake_case.
          pull_request: {
            base: {ref: 'main', sha: 'abc1234567890def'},
            head: {ref: 'feature', sha: 'def0987654321abc'},
            number: 99,
          },
        };
        writeFileSync(eventPath, JSON.stringify(eventPayload));
      }

      // Run the BUNDLED entry from the isolated copy.
      const bundledEntryPath = join(isolatedBundleDir, 'bundle', action.bundleFile);
      const bundledStartMs = Date.now();
      const bundledResult = spawnSync('node', [bundledEntryPath], {
        cwd: tempProjectDir,
        encoding: 'utf8',
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: ACTION_TIMEOUT_MS,
      });
      const bundledElapsedMs = Date.now() - bundledStartMs;

      // Handle spawn errors.
      if (bundledResult.error || bundledResult.signal || bundledResult.status === null) {
        const reason = bundledResult.error
          ? `Spawn error: ${bundledResult.error.message}`
          : bundledResult.signal
            ? `Killed by signal ${bundledResult.signal}`
            : `Timeout (${ACTION_TIMEOUT_MS}ms)`;
        results.push({
          details: reason,
          name: action.name,
          ok: false,
        });
        continue;
      }

      // Check exit code and pattern match.
      const bundledOutput = (bundledResult.stdout || '') + '\n' + (bundledResult.stderr || '');
      const bundledMatches = config.expect.test(bundledOutput);
      const bundledExitOk = bundledResult.status !== 0;

      if (!bundledExitOk || !bundledMatches) {
        results.push({
          details: `Bundled entry failed: exit ${bundledResult.status} (expected nonzero), pattern match: ${bundledMatches}. Output: ${bundledOutput.slice(0, 200)}`,
          name: action.name,
          ok: false,
        });
        continue;
      }

      // Run the UNBUNDLED entry (tsc output in packages/actions/dist/).
      const unbundledJsFile = action.bundleFile.replace(/\.mjs$/, '.js');
      const unbundledEntryPath = join(actionsDir, 'dist', unbundledJsFile);

      if (!existsSync(unbundledEntryPath)) {
        results.push({
          details: `Unbundled dist entry not found: ${unbundledEntryPath}`,
          name: action.name,
          ok: false,
        });
        continue;
      }

      const unbundledStartMs = Date.now();
      const unbundledResult = spawnSync('node', [unbundledEntryPath], {
        cwd: tempProjectDir,
        encoding: 'utf8',
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: ACTION_TIMEOUT_MS,
      });
      const unbundledElapsedMs = Date.now() - unbundledStartMs;

      // Normalize and compare error lines.
      const bundledLines = normalizeOutput(bundledOutput);
      const unbundledOutput = (unbundledResult.stdout || '') + '\n' + (unbundledResult.stderr || '');
      const unbundledLines = normalizeOutput(unbundledOutput);

      const bundledErrors = bundledLines.filter(l => l.startsWith('::error::'));
      const unbundledErrors = unbundledLines.filter(l => l.startsWith('::error::'));

      const errorMatch = JSON.stringify(bundledErrors) === JSON.stringify(unbundledErrors);

      if (!errorMatch) {
        results.push({
          details: `Error output mismatch: bundled ${bundledErrors.length} lines, unbundled ${unbundledErrors.length} lines. Bundled: ${JSON.stringify(bundledErrors).slice(0, 150)}. Unbundled: ${JSON.stringify(unbundledErrors).slice(0, 150)}`,
          name: action.name,
          ok: false,
        });
        continue;
      }

      results.push({
        details: `PASS (bundled: ${bundledElapsedMs}ms, unbundled: ${unbundledElapsedMs}ms, error lines match)`,
        name: action.name,
        ok: true,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        details: `Exception: ${msg}`,
        name: action.name,
        ok: false,
      });
    } finally {
      rmSync(tempProjectDir, {force: true, recursive: true});
    }
  }

  return results;
}

/**
 * Scan bundled packages for on-disk Messages loading. Returns [{name, ok, details}, ...].
 */
function runMessagesCheck(metafilePath) {
  let metafile;
  try {
    metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
  } catch {
    return [{details: 'Metafile not readable', name: 'Messages', ok: false}];
  }

  if (!metafile.inputs) {
    return [{details: 'No inputs in metafile', name: 'Messages', ok: false}];
  }

  const libDirs = new Map(); // libName -> Set of libDir path strings

  for (const inputPath of Object.keys(metafile.inputs)) {
    const resolved = resolvePackage(resolve(actionsDir, inputPath));
    if (!resolved) continue; // Workspace-internal file.

    for (const libName of MESSAGES_LIBRARIES) {
      if (resolved.name === libName) {
        if (!libDirs.has(libName)) {
          libDirs.set(libName, new Set());
        }

        libDirs.get(libName).add(join(resolved.pkgRoot, 'lib'));
      }
    }
  }

  const findings = [];
  let allOk = true;

  for (const libName of MESSAGES_LIBRARIES) {
    const entries = libDirs.get(libName);

    if (!entries || entries.size === 0) {
      if (libName === '@salesforce/packaging') {
        findings.push(`${libName}: NOT FOUND (critical: messages/ directory shipped, but package not bundled)`);
        allOk = false;
      } else {
        findings.push(`${libName}: not bundled`);
      }

      continue;
    }

    let found = false;
    for (const libDir of entries) {
      // Only @salesforce/core's own loader-implementation files are excluded,
      // and only when scanning core itself — a same-named file in another
      // library (packaging, SDR, apex-node) is still scanned in full.
      const excluded = libName === '@salesforce/core'
        ? new Set(CORE_EXCLUDED_FILES.map(file => join(libDir, file)))
        : new Set();
      if (searchForRealMessageCall(libDir, excluded)) {
        found = true;
        break;
      }
    }

    if (found) {
      if (libName === '@salesforce/packaging') {
        findings.push(`${libName}: FOUND (loads messages at runtime — shipped messages/ directory is correct)`);
      } else {
        findings.push(`${libName}: FOUND (loading messages, but only @salesforce/packaging should)`);
        allOk = false;
      }
    } else if (libName === '@salesforce/packaging') {
      findings.push(`${libName}: NOT FOUND loading messages (but messages/ directory is shipped)`);
      allOk = false;
    } else {
      findings.push(`${libName}: no on-disk messages loading`);
    }
  }

  findings.push(`Excluded (loader internals): ${CORE_EXCLUDED_FILES.map(file => `@salesforce/core/lib/${file}`).join(', ')}`);

  return [{
    details: findings.join('; '),
    name: 'Messages',
    ok: allOk,
  }];
}

/**
 * Test jiti loading a TypeScript config through bundled resolution.
 * Returns [{name, ok, details}].
 */
function runJitiCheck(isolatedBundleDir) {
  const results = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'sfpm-jiti-'));

  try {
    const probeDir = join(isolatedBundleDir, 'bundle', 'chunks');
    mkdirSync(probeDir, {recursive: true});

    const configPath = join(tempDir, 'sfpm.config.ts');
    writeFileSync(configPath, 'export default {};');

    const probeFile = join(probeDir, `jiti-probe-${randomBytes(8).toString('hex')}.mjs`);
    const probeScript = `
import createJiti from 'jiti';

(async () => {
  try {
    const jiti = createJiti(import.meta.url, {});
    const config = await jiti.import(${JSON.stringify(configPath)});
    console.log('SUCCESS: jiti loaded config');
    process.exit(0);
  } catch (error) {
    console.error('ERROR:', error.message || error);
    process.exit(1);
  }
})();
`;

    writeFileSync(probeFile, probeScript);

    const jitiTest = spawnSync('node', [probeFile], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {PATH: process.env.PATH},
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });

    const output = (jitiTest.stdout || '') + '\n' + (jitiTest.stderr || '');

    if (output.includes('SUCCESS: jiti loaded config')) {
      results.push({details: 'PASS', name: 'jiti', ok: true});
    } else if (/ERR_|Cannot find|no such|not found/i.test(output)) {
      results.push({details: `Module/resolution error: ${output.slice(0, 150)}`, name: 'jiti', ok: false});
    } else {
      results.push({details: `Unexpected output: ${output.slice(0, 150)}`, name: 'jiti', ok: false});
    }

    // Always clean up the probe file so it never reaches version control.
    rmSync(probeFile, {force: true});
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({details: `Exception: ${msg}`, name: 'jiti', ok: false});
  } finally {
    rmSync(tempDir, {force: true, recursive: true});
  }

  return results;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the allowlisted environment for a child action process. Includes PATH,
 * NODE_OPTIONS (if set), TMPDIR, HOME, USERPROFILE, GITHUB_OUTPUT/STATE, INPUT_*,
 * SF_DISABLE_TELEMETRY, SF_AUTOUPDATE_DISABLE, and per-action `env` from ACTION_CONFIG.
 */
function buildChildEnv(config, tempDir, outputFile, stateFile) {
  const env = {
    GITHUB_OUTPUT: outputFile,
    GITHUB_STATE: stateFile,
    // Use temp directory as HOME so .sf config doesn't leak from the host.
    HOME: tempDir,
    PATH: process.env.PATH,
    SF_AUTOUPDATE_DISABLE: 'true',
    SF_DISABLE_TELEMETRY: 'true',
    // Without a pre-existing OS keychain entry (guaranteed on a fresh, isolated
    // HOME), @salesforce/core's crypto module falls back to first-time native
    // keychain provisioning (Keychain.app on macOS, libsecret/gnome-keyring on
    // Linux desktops). That provisioning step waits on OS-level authorization
    // that never arrives in a headless run, hanging indefinitely instead of
    // failing. Forcing the generic, file-based keychain sidesteps any OS
    // keychain entirely, so this is deterministic on every platform and CI
    // runner, not just a workaround for one host.
    SF_USE_GENERIC_UNIX_KEYCHAIN: 'true',
    TMPDIR: tempDir,
    USERPROFILE: tempDir,
  };

  if (process.env.NODE_OPTIONS) {
    env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  }

  // Merge per-action config env.
  if (config.env) {
    const extra = typeof config.env === 'function' ? config.env(tempDir) : config.env;
    // Remap camelCase to snake_case for npm env vars (npmConfigRegistry -> npm_config_registry)
    for (const [key, value] of Object.entries(extra)) {
      const envKey = key.startsWith('npm')
        ? key.replaceAll(/([A-Z])/g, '_$1').toLowerCase()
        : key;
      env[envKey] = value;
    }
  }

  return env;
}

/**
 * Normalize output for parity comparison: strip absolute paths, stack frames,
 * and timestamps. Returns array of lines.
 */
function normalizeOutput(output) {
  return output
  .split('\n')
  .map(line => {
    // Strip absolute file paths (simplistic: anything that looks like /path/to/file or c:\path\to\file).
    let normalized = line.replaceAll(/(?:\/[^\s]+|[a-zA-Z]:\\[^\s]+)/g, '<path>');
    // Strip stack frames (lines starting with 'at ').
    if (normalized.trim().startsWith('at ')) return '';
    // Strip timestamps (rough: YYYY-MM-DD, ISO 8601, unix timestamps).
    normalized = normalized.replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '<timestamp>');
    normalized = normalized.replaceAll(/\d{10,13}(?=\D|$)/g, '<timestamp>');
    return normalized;
  })
  .filter(Boolean);
}

/**
 * Search a library directory recursively for a real (non-comment, non-excluded)
 * Messages-loading call. Returns true on first match.
 */
function searchForRealMessageCall(dir, excludedPaths = new Set()) {
  try {
    for (const item of readdirSync(dir)) {
      const fullPath = join(dir, item);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !item.includes('node_modules')) {
        if (searchForRealMessageCall(fullPath, excludedPaths)) return true;
      } else if (stat.isFile() && /\.(js|cjs)$/.test(item) && !excludedPaths.has(fullPath)) {
        const content = readTextIfExists(fullPath);
        if (!content) continue;

        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          // Skip comment lines and docstring examples.
          if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
          for (const pattern of MESSAGES_PATTERNS) {
            if (pattern.test(line)) return true;
          }
        }
      }
    }
  } catch {
    // Ignore unreadable directories.
  }

  return false;
}

/**
 * Format and report all results from the three check phases.
 */
function report(allResults) {
  console.log('\n========== SMOKE TEST RESULTS ==========\n');

  for (const result of allResults) {
    const symbol = result.ok ? '✓' : '✗';
    const status = result.ok ? 'PASS' : 'FAIL';
    console.log(`${symbol} ${result.name.padEnd(25)} ${status.padEnd(6)} ${result.details}`);
  }

  const hasFailure = allResults.some(r => !r.ok);

  console.log('\n========== SUMMARY ==========\n');
  if (hasFailure) {
    console.log('❌ SMOKE TEST FAILED: One or more checks failed.');
    return 1;
  }

  console.log('✅ SMOKE TEST PASSED: All checks passed.');
  return 0;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Step 1: Create isolated bundle copy with guard.
  console.log('[SMOKE TEST] Creating isolated bundle copy...');
  const isolatedBundleDir = mkdtempSync(join(tmpdir(), 'sfpm-bundle-'));

  try {
    cpSync(bundleDir, join(isolatedBundleDir, 'bundle'), {recursive: true});

    // Guard: if the isolated copy is inside the repo, throw loudly. Compares
    // against repoRealpath + a trailing separator (not a bare prefix match)
    // so a sibling directory that merely starts with the same characters
    // (e.g. repoRoot "/x/sfpm" vs an unrelated "/x/sfpm-other") can't
    // false-positive.
    const isolatedRealpath = await realpath(isolatedBundleDir);
    const repoRealpath = await realpath(repoRoot);
    if (isolatedRealpath === repoRealpath || isolatedRealpath.startsWith(repoRealpath + sep)) {
      throw new Error(`SAFETY CHECK FAILED: Isolated bundle copy at ${isolatedRealpath} is inside repo root ${repoRealpath}. `
        + 'TMPDIR may be misconfigured. Set TMPDIR to a directory outside the repo and try again.');
    }

    // Step 2: Discover actions from manifests.
    console.log('[SMOKE TEST] Discovering actions from manifests...');
    const actions = await listActions();

    // Step 3: Run all three check phases.
    console.log(`[SMOKE TEST] Discovered ${actions.length} actions. Starting test phases...\n`);

    console.log('[SMOKE TEST] Phase 1: Running action checks with parity comparison...');
    const actionResults = await runActionChecks(isolatedBundleDir, actions);

    console.log('[SMOKE TEST] Phase 2: Scanning Messages-loading patterns...');
    const metafilePath = join(actionsDir, 'bundle-metafile.json');
    const messagesResults = runMessagesCheck(metafilePath);

    console.log('[SMOKE TEST] Phase 3: Testing jiti loading...');
    const jitiResults = runJitiCheck(isolatedBundleDir);

    // Step 4: Combine and report all results.
    const allResults = [...actionResults, ...messagesResults, ...jitiResults];
    process.exitCode = report(allResults);
  } finally {
    // Always clean up the isolated bundle copy, even if a check above threw.
    rmSync(isolatedBundleDir, {force: true, recursive: true});
  }
}

try {
  await main();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${msg}`);
  process.exitCode = 1;
}
