import {resolveSfpmRoot} from '@b64hub/sfpm-core'

/**
 * Resolve the sfpm project root for this CLI invocation.
 *
 * `SFPM_PROJECT_DIR` overrides discovery — useful for running the CLI
 * against a project you're not currently in (e.g. local debugging).
 * Otherwise walks up from `process.cwd()` looking for
 * `sfpm.config.{ts,js,mjs}`. Throws if neither resolves to a project root.
 */
export function resolveCliProjectDir(): string {
  return resolveSfpmRoot(process.env.SFPM_PROJECT_DIR || process.cwd())
}
