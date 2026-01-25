import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

// Import the official types from your local copy
import type * as jorje from "../types/jorje.d.js";

/**
 * The internal engine returns a JSON with a very specific, long string as the key.
 * We define it here to handle it type-safely.
 */
const PARSER_OUTPUT_KEY = "apex.jorje.semantic.compiler.parser.ParserOutput" as const;

export interface SerializerOptions {
  serverUrl?: string;
}

/**
 * Shape of the raw response from the Java Serializer (Server or CLI).
 * This acts as a bridge between the raw JSON and our typed ParserOutput.
 *
 */
export interface RawAstResponse {
  [PARSER_OUTPUT_KEY]: jorje.ParserOutput;
}

export class ApexAstSerializer {
  private serverUrl: string;

  constructor(options: SerializerOptions = {}) {
    this.serverUrl = options.serverUrl || "http://localhost:2117/api/ast";
  }

  /**
   * Primary entry point to get the raw AST.
   * Returns a typed jorje.ParserOutput to avoid manual casting in consumer classes.
   *
   */
  public async serialize(sourceCode: string, anonymous = false): Promise<jorje.ParserOutput> {
    const response = (await this.tryServer(sourceCode, anonymous)) || 
                     (await this.tryBinary(sourceCode, anonymous));

    if (!response) {
      throw new Error("Apex Serialization failed: No server or binary available.");
    }

    // Extract the typed output from the response wrapper
    const output = response[PARSER_OUTPUT_KEY];
    
    if (!output) {
      throw new Error(`Invalid Serializer response: missing key '${PARSER_OUTPUT_KEY}'`);
    }

    return output;
  }

  private async tryServer(sourceCode: string, anonymous: boolean): Promise<RawAstResponse | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 500);

      const response = await fetch(this.serverUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceCode, anonymous, prettyPrint: false }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      
      if (response.ok) {
        return (await response.json()) as RawAstResponse;
      }
    } catch {
      return null;
    }
    return null;
  }

  private async tryBinary(sourceCode: string, anonymous: boolean): Promise<RawAstResponse | null> {
    const binaryPath = this.resolveBinaryPath();
    if (!binaryPath) return null;

    return new Promise((resolve) => {
      const args = anonymous ? ["-a"] : [];
      const childProcess = spawn(binaryPath, args, {
        shell: true,
        env: { ...process.env, DEBUG: "" } // #1513: Prevent verbose logs
      });

      let stdout = "";
      childProcess.stdout.on("data", (data) => (stdout += data));
      childProcess.stdin.write(sourceCode);
      childProcess.stdin.end();

      childProcess.on("close", (code) => {
        if (code === 0 && stdout) {
          try { 
            resolve(JSON.parse(stdout) as RawAstResponse); 
          } catch { 
            resolve(null); 
          }
        } else { 
          resolve(null); 
        }
      });
      childProcess.on("error", () => resolve(null));
    });
  }

  private resolveBinaryPath(): string | null {
    const { platform, arch } = process;
    const pkgName = `@prettier-apex/apex-ast-serializer-${platform}-${arch}`;
    const binName = platform === "win32" ? "apex-ast-serializer.bat" : "apex-ast-serializer";
    
    // Direct path resolution to node_modules
    const fullPath = path.resolve("node_modules", pkgName, "bin", binName);
    return existsSync(fullPath) ? fullPath : null;
  }
}