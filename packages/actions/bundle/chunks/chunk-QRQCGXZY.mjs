import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';

// ../../node_modules/.pnpm/@opentelemetry+resources@3.1.0_@opentelemetry+api@1.10.0/node_modules/@opentelemetry/resources/dist/detectors/platform/node/machine-id/execAsync.mjs
import * as child_process from "child_process";
import * as util from "util";
var execAsync = util.promisify(child_process.exec);

export {
  execAsync
};
