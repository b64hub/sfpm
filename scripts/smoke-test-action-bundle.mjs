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

import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = join(repoRoot, 'packages', 'actions', 'bundle');

/** Action entries and their required inputs from their -main.ts files. */
const ACTIONS = [
  {name: 'build', entry: 'build-main.mjs', required: []},
  {name: 'build-turbo-aggregate', entry: 'build-turbo-aggregate-main.mjs', required: []},
  {name: 'build-validation', entry: 'build-validation-main.mjs', required: ['build-result']},
  {name: 'clean-pool', entry: 'clean-pool-main.mjs', required: ['devhub-username', 'pool-tag']},
  {name: 'deploy', entry: 'deploy-main.mjs', required: ['target-org', 'packages']},
  {name: 'install', entry: 'install-main.mjs', required: ['target-org', 'packages']},
  {name: 'validate-pr', entry: 'validate-main.mjs', required: []},
  {name: 'fill-pool', entry: 'fill-pool-main.mjs', required: ['devhub-username', 'pool-tag']},
];

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
 */
const MESSAGES_REAL_CALL = /\.importMessagesDirectory\(\s*(?:__dirname|path\.dirname\()/;
const MESSAGES_LIBRARIES = [
  '@salesforce/packaging',
  '@salesforce/source-deploy-retrieve',
  '@salesforce/core',
  '@salesforce/apex-node',
];

const results = [];

// ============================================================================
// Test each action entry
// ============================================================================

console.log('Starting smoke test for bundled GitHub Actions...\n');

for (const action of ACTIONS) {
  const entryPath = join(bundleDir, action.entry);

  if (!existsSync(entryPath)) {
    results.push({name: action.name, status: 'FAIL', reason: `Bundle entry not found: ${entryPath}`});
    continue;
  }

  // Create a temp directory for this action's run.
  const tempDir = mkdtempSync(join(tmpdir(), 'sfpm-smoke-'));

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
      const envName = `INPUT_${inputName.toUpperCase()}`;
      // Provide placeholder values; they'll likely fail for legit domain reasons.
      if (inputName === 'devhub-username') env[envName] = 'placeholder-dh-user';
      else if (inputName === 'pool-tag') env[envName] = 'placeholder-pool';
      else if (inputName === 'target-org') env[envName] = 'placeholder-target';
      else if (inputName === 'packages') env[envName] = 'placeholder-pkg';
      else if (inputName === 'build-result') env[envName] = '{}';
      else env[envName] = `placeholder-${inputName}`;
    }

    // Run the action entry.
    const result = spawnSync('node', [entryPath], {
      cwd: tempDir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000, // 30s timeout per action
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const combined = stdout + '\n' + stderr;

    // Check for infrastructure/module errors.
    const badPatterns = [
      /ERR_MODULE_NOT_FOUND/,
      /Cannot find module/i,
      /cannot find|no such/i, // Combined check for missing-file errors
      /messages?.*(?:missing|cannot find|no such|not found)/i, // Messages loading failure
      /(?:missing|cannot find|no such|not found).*messages?/i, // Reversed order
      /worker.*ERR_|ERR_.*worker/i, // pino worker-thread errors
      /Bare specifier/i, // Module resolution error specific to dynamic import
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
      // Exit code and overall result: domain errors (non-zero exit) are OK.
      results.push({
        name: action.name,
        status: 'PASS',
        exitCode: result.status,
        reason: result.status === 0 ? 'Clean exit' : `Domain error (exit ${result.status})`,
      });
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
 * Search a directory recursively for files matching a pattern.
 * Returns true if the pattern is found.
 */
function searchForPattern(dir, patternRegex, ext = /\.(js|cjs)$/) {
  try {
    const items = readdirSync(dir);
    for (const item of items) {
      const fullPath = join(dir, item);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !item.includes('node_modules')) {
        if (searchForPattern(fullPath, patternRegex, ext)) {
          return true;
        }
      } else if (stat.isFile() && ext.test(item)) {
        try {
          const content = readFileSync(fullPath, 'utf8');
          if (patternRegex.test(content)) {
            return true;
          }
        } catch (e) {
          // Skip unreadable files
        }
      }
    }
  } catch (e) {
    // Ignore directory read errors
  }
  return false;
}

/**
 * Search a directory recursively for a real (non-comment) call matching
 * `pattern`, skipping known non-runtime files. Returns true on the first hit.
 */
function searchForRealCall(dir, pattern, ext = /\.(js|cjs)$/) {
  try {
    for (const item of readdirSync(dir)) {
      const fullPath = join(dir, item);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !item.includes('node_modules')) {
        if (searchForRealCall(fullPath, pattern, ext)) return true;
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
            if (pattern.test(line)) return true;
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

for (const libName of MESSAGES_LIBRARIES) {
  // Find the actual installed package in pnpm's virtual store.
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');
  let found = false;

  try {
    // pnpm stores packages like @salesforce+core@8.31.0_..., so search for the pattern.
    const items = readdirSync(pnpmDir);
    const baseLibName = libName.split('/')[1]; // Extract 'core' from '@salesforce/core'

    for (const item of items) {
      if (item.includes(baseLibName)) {
        const libSearchPath = join(pnpmDir, item, 'node_modules', libName);
        if (existsSync(libSearchPath)) {
          const libDir = join(libSearchPath, 'lib');
          if (existsSync(libDir) && searchForRealCall(libDir, MESSAGES_REAL_CALL)) {
            found = true;
            messagesFindings.push(`${libName}: FOUND (real \`.importMessagesDirectory(__dirname)\`-style call at runtime — reads messages/ from disk)`);
            break;
          }
        }
      }
    }

    if (!found) {
      messagesFindings.push(`${libName}: no real on-disk messages loading at runtime (messages are pre-inlined or absent)`);
    }
  } catch (error) {
    messagesFindings.push(`${libName}: check skipped (${String(error).slice(0, 40)})`);
  }
}

// ============================================================================
// Check jiti loading with a trivial sfpm.config.ts
// ============================================================================

console.log('\nChecking jiti/sfpm.config.ts loading...\n');

let jitiTestResult = 'UNKNOWN';
const jitiTempDir = mkdtempSync(join(tmpdir(), 'sfpm-jiti-'));

try {
  // Write a minimal sfpm.config.ts
  const configContent = 'export default {};';
  writeFileSync(join(jitiTempDir, 'sfpm.config.ts'), configContent);

  // Create a test script that imports jiti from the bundle and loads the config.
  // jiti is available as an external at bundle/node_modules/jiti/
  const testScript = `
(async () => {
  try {
    // Import jiti from the bundled copy
    const {default: createJiti} = await import('${bundleDir}/node_modules/jiti/lib/jiti.cjs');
    const jiti = createJiti(import.meta.url, {});
    const config = await jiti.import('./sfpm.config.ts');
    console.log('SUCCESS: jiti loaded config');
    process.exit(0);
  } catch (error) {
    console.error('ERROR:', error.message || error);
    process.exit(1);
  }
})();
`;

  writeFileSync(join(jitiTempDir, 'test-jiti.mjs'), testScript);

  const jitiTest = spawnSync('node', [join(jitiTempDir, 'test-jiti.mjs')], {
    cwd: jitiTempDir,
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

console.log('\n--- jiti/sfpm.config.ts Loading ---');
console.log(`  ${jitiTestResult}`);

const hasFailures = results.some((r) => r.status === 'FAIL');
const hasJitiFailure = jitiTestResult.startsWith('FAIL');

if (hasFailures) {
  console.log('\n❌ SMOKE TEST FAILED: Some entries have infrastructure errors.');
  process.exitCode = 1;
} else if (hasJitiFailure) {
  console.log('\n⚠️  SMOKE TEST PARTIAL: All bundle entries passed, but jiti loading may have issues.');
  process.exitCode = 1;
} else {
  console.log('\n✅ SMOKE TEST PASSED: All entries and checks passed.');
  process.exitCode = 0;
}
