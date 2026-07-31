import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNimbusTestJson, parseNimbusValidateJson } from '../../../src/adapters/nimbus/parse-nimbus-json.js';

function fixture(name: string): string {
  return readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), 'utf8');
}

describe('parseNimbusValidateJson', () => {
  it('passed fixture → status passed, no diagnostics', () => {
    const result = parseNimbusValidateJson(fixture('nimbus-validate-passed.json'), '', 0, 100);
    expect(result.status).toBe('passed');
    expect(result.capability).toBe('compile');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('failed fixture → status failed, correct diagnostic', () => {
    const result = parseNimbusValidateJson(fixture('nimbus-validate-failed.json'), '', 1, 200);
    expect(result.status).toBe('failed');
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0];
    expect(d.line).toBe(27);
    expect(d.column).toBe(18);
    expect(d.message).toContain("missing ';'");
    expect(d.filePath).toBe('OrderService.cls');
  });

  it('malformed JSON → falls back to exit-code status, one warning, no throw', () => {
    const result = parseNimbusValidateJson('not-json', '', 0, 50);
    expect(result.status).toBe('passed'); // exit code 0 → passed
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].severity).toBe('warning');
  });

  it('malformed JSON with non-zero exit → failed status', () => {
    const result = parseNimbusValidateJson('not-json', '', 1, 50);
    expect(result.status).toBe('failed');
  });
});

describe('parseNimbusTestJson', () => {
  it('passed fixture → status passed, no diagnostics, correct durationMs', () => {
    const result = parseNimbusTestJson(fixture('nimbus-test-passed.json'), '', 0, 9999);
    expect(result.status).toBe('passed');
    expect(result.capability).toBe('test');
    expect(result.diagnostics).toHaveLength(0);
    // durationMs comes from fixture summary.duration_ms, not the argument
    expect(result.durationMs).toBe(3542);
  });

  it('malformed JSON → falls back to exit-code status, one warning, no throw', () => {
    const result = parseNimbusTestJson('{bad json}', '', 0, 50);
    expect(result.status).toBe('passed');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].severity).toBe('warning');
  });
});
