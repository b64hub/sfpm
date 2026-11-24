import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  execAsync
} from "./chunk-QRQCGXZY.mjs";
import {
  diag
} from "./chunk-SZNJWE6U.mjs";
import "./chunk-4ZHSI3J6.mjs";

// ../../node_modules/.pnpm/@opentelemetry+resources@3.1.0_@opentelemetry+api@1.10.0/node_modules/@opentelemetry/resources/dist/detectors/platform/node/machine-id/getMachineId-win.mjs
import * as process from "process";
async function getMachineId() {
  const args = "QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid";
  let command = "%windir%\\System32\\REG.exe";
  if (process.arch === "ia32" && "PROCESSOR_ARCHITEW6432" in process.env) command = "%windir%\\sysnative\\cmd.exe /c " + command;
  try {
    const parts = (await execAsync(`${command} ${args}`)).stdout.split("REG_SZ");
    if (parts.length === 2) return parts[1].trim();
  } catch (e) {
    diag.debug(`error reading machine id: ${e}`);
  }
}
export {
  getMachineId
};
