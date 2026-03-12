/**
 * Environment variable names for CI/CD pipeline run identifiers,
 * checked in priority order.
 */
const PIPELINE_RUN_ID_ENV_VARS = [
  'GITHUB_RUN_ID',        // GitHub Actions
  'BUILD_BUILDID',        // Azure DevOps
  'CI_PIPELINE_ID',       // GitLab CI
  'BITBUCKET_BUILD_NUMBER', // Bitbucket Pipelines
  'CIRCLE_BUILD_NUM',     // CircleCI
  'CODEBUILD_BUILD_ID',   // AWS CodeBuild
] as const;

/**
 * Detect the current CI/CD pipeline run identifier from environment variables.
 *
 * Checks common CI systems in priority order and returns the first match.
 * Returns `undefined` when running outside of a CI/CD environment.
 */
export function getPipelineRunId(): string | undefined {
  for (const envVar of PIPELINE_RUN_ID_ENV_VARS) {
    const value = process.env[envVar];
    if (value) {
      return value;
    }
  }

  return undefined;
}
