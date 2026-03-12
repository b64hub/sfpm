import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {getPipelineRunId} from '../../src/utils/pipeline.js';

describe('getPipelineRunId', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env to a clean clone before each test
    process.env = {...originalEnv};
    // Remove all CI env vars to start clean
    delete process.env.GITHUB_RUN_ID;
    delete process.env.BUILD_BUILDID;
    delete process.env.CI_PIPELINE_ID;
    delete process.env.BITBUCKET_BUILD_NUMBER;
    delete process.env.CIRCLE_BUILD_NUM;
    delete process.env.CODEBUILD_BUILD_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return undefined when no CI env vars are set', () => {
    expect(getPipelineRunId()).toBeUndefined();
  });

  it('should return GITHUB_RUN_ID when set', () => {
    process.env.GITHUB_RUN_ID = '12345';
    expect(getPipelineRunId()).toBe('12345');
  });

  it('should return BUILD_BUILDID for Azure DevOps', () => {
    process.env.BUILD_BUILDID = 'azure-42';
    expect(getPipelineRunId()).toBe('azure-42');
  });

  it('should return CI_PIPELINE_ID for GitLab', () => {
    process.env.CI_PIPELINE_ID = 'gitlab-99';
    expect(getPipelineRunId()).toBe('gitlab-99');
  });

  it('should return BITBUCKET_BUILD_NUMBER for Bitbucket', () => {
    process.env.BITBUCKET_BUILD_NUMBER = 'bb-7';
    expect(getPipelineRunId()).toBe('bb-7');
  });

  it('should return CIRCLE_BUILD_NUM for CircleCI', () => {
    process.env.CIRCLE_BUILD_NUM = 'circle-123';
    expect(getPipelineRunId()).toBe('circle-123');
  });

  it('should return CODEBUILD_BUILD_ID for AWS CodeBuild', () => {
    process.env.CODEBUILD_BUILD_ID = 'codebuild:abc-def';
    expect(getPipelineRunId()).toBe('codebuild:abc-def');
  });

  it('should prioritize GITHUB_RUN_ID over other CI env vars', () => {
    process.env.GITHUB_RUN_ID = 'gh-1';
    process.env.BUILD_BUILDID = 'azure-2';
    process.env.CI_PIPELINE_ID = 'gitlab-3';
    expect(getPipelineRunId()).toBe('gh-1');
  });

  it('should fall through to lower-priority vars when higher ones are not set', () => {
    process.env.CI_PIPELINE_ID = 'gitlab-3';
    process.env.BITBUCKET_BUILD_NUMBER = 'bb-4';
    expect(getPipelineRunId()).toBe('gitlab-3');
  });

  it('should skip empty string env vars', () => {
    process.env.GITHUB_RUN_ID = '';
    process.env.BUILD_BUILDID = 'azure-42';
    expect(getPipelineRunId()).toBe('azure-42');
  });
});
