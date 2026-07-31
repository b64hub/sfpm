export interface ValidationContext {
  compilePattern?: string;
  packageId: string;
  packagePath: string;
  projectRoot: string;
  signal?: AbortSignal;
  testPattern?: string;
  timeoutMs?: number;
}
