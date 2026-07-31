import {satisfies} from 'semver';

import type {ValidationContext} from '../../contracts/validation-context.js';
import type {
  AvailabilityResult, ValidationCapability, ValidationResult, Validator,
} from '../../contracts/validator.js';
import type {NimbusAdapterDeps} from './config.js';

import {INSTALL_HINT, resolveNimbusBinary} from './nimbus-binary.js';
import {runNimbus} from './nimbus-process.js';
import {parseNimbusTestJson, parseNimbusValidateJson} from './parse-nimbus-json.js';

export function createNimbusValidator(deps: NimbusAdapterDeps): Validator {
  const {config, eventBus, logger: rootLogger} = deps;

  const checkAvailability = async ({packageId}: Pick<ValidationContext, 'packageId'>): Promise<AvailabilityResult> => {
    const logger = rootLogger.child?.({packageId, validator: 'nimbus'}) ?? rootLogger;
    const path = await resolveNimbusBinary(deps);
    if (!path) {
      const result: AvailabilityResult = {
        available: false,
        reason: 'nimbus binary not found',
        remediation: INSTALL_HINT,
      };
      eventBus.emit('validator:availability', {availability: result, packageId, validator: 'nimbus'});
      return result;
    }

    const versionOutput = await runNimbus(path, ['--version'], process.cwd(), {logger});
    const version = versionOutput.stdout.trim().replace(/^nimbus\s+/i, '');
    const compatible = satisfies(version, config.supportedVersionRange);
    const result: AvailabilityResult = {
      available: true,
      compatible,
      reason: compatible
        ? undefined
        : `nimbus ${version} outside supported range ${config.supportedVersionRange}`,
      version,
    };
    eventBus.emit('validator:availability', {availability: result, packageId, validator: 'nimbus'});
    return result;
  };

  return {
    capabilities: ['compile', 'test'],
    checkAvailability,
    name: 'nimbus',

    async run(capability: ValidationCapability, context: ValidationContext): Promise<ValidationResult> {
      const logger = rootLogger.child?.({capability, packageId: context.packageId, validator: 'nimbus'}) ?? rootLogger;
      const start = Date.now();
      eventBus.emit('validator:start', {capability, packageId: context.packageId, validator: 'nimbus'});

      const availability = await checkAvailability(context);
      if (!availability.available || availability.compatible === false) {
        const result: ValidationResult = {
          capability,
          diagnostics: [{message: availability.reason ?? 'nimbus unavailable', severity: 'info'}],
          durationMs: Date.now() - start,
          status: 'skipped',
        };
        eventBus.emit('validator:complete', {packageId: context.packageId, result, validator: 'nimbus'});
        return result;
      }

      const binary = await resolveNimbusBinary(deps);
      if (!binary) {
        const result: ValidationResult = {
          capability,
          diagnostics: [{message: `nimbus binary not found. ${INSTALL_HINT}`, severity: 'info'}],
          durationMs: Date.now() - start,
          status: 'skipped',
        };
        eventBus.emit('validator:complete', {packageId: context.packageId, result, validator: 'nimbus'});
        return result;
      }

      const args
        = capability === 'compile'
          ? ['validate', context.compilePattern ?? '*', '--json']
          : ['test', context.testPattern ?? '*', '--json'];

      try {
        const {exitCode, stderr, stdout, timedOut} = await runNimbus(binary, args, context.packagePath, {
          logger,
          signal: context.signal,
          timeoutMs: context.timeoutMs,
        });

        if (timedOut) {
          const result: ValidationResult = {
            capability,
            diagnostics: [
              {message: `nimbus ${capability} timed out after ${context.timeoutMs}ms`, severity: 'error'},
            ],
            durationMs: Date.now() - start,
            status: 'error',
          };
          eventBus.emit('validator:complete', {packageId: context.packageId, result, validator: 'nimbus'});
          return result;
        }

        const result
          = capability === 'compile'
            ? parseNimbusValidateJson(stdout, stderr, exitCode, Date.now() - start)
            : parseNimbusTestJson(stdout, stderr, exitCode, Date.now() - start);
        eventBus.emit('validator:complete', {packageId: context.packageId, result, validator: 'nimbus'});
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`nimbus: run failed: ${error instanceof Error ? error.message : String(error)}`);
        eventBus.emit('validator:error', {message, packageId: context.packageId, validator: 'nimbus'});
        const result: ValidationResult = {
          capability,
          diagnostics: [{message, severity: 'error'}],
          durationMs: Date.now() - start,
          status: 'error',
        };
        // Emit validator:complete on every exit path so bus consumers are never left waiting
        eventBus.emit('validator:complete', {packageId: context.packageId, result, validator: 'nimbus'});
        return result;
      }
    },
  };
}
