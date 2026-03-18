// ============================================================================
// LWC TypeScript Hook Options
// ============================================================================

/**
 * Configuration options for the LWC TypeScript compilation hook.
 *
 * Compiles TypeScript source files to JavaScript for Lightning Web
 * Components as a pre-build step. Enables authoring LWC controllers
 * in TypeScript while producing valid JS for the Salesforce platform.
 */
export interface LwcTypescriptHooksOptions {
  /**
   * Glob patterns to exclude from compilation.
   * @default ['**\/*.d.ts', '**\/__tests__/**']
   */
  exclude?: string[];

  /**
   * Glob patterns for LWC TypeScript source files.
   * When omitted, defaults to all `.ts` files under `lwc/` directories.
   *
   * @default ['**\/lwc/**\/*.ts']
   */
  include?: string[];

  /**
   * Whether to remove the original `.ts` source files from the
   * staging directory after compilation.
   * @default true
   */
  removeSourceFiles?: boolean;

  /**
   * Path to a custom tsconfig.json for LWC compilation.
   * When omitted, the hook uses a built-in configuration
   * suitable for LWC targets.
   */
  tsconfig?: string;
}

// ============================================================================
// LWC Tailwind Hook Options
// ============================================================================

/**
 * Configuration options for the LWC Tailwind CSS generation hook.
 *
 * Generates scoped CSS files for Lightning Web Components from
 * Tailwind utility classes as a pre-build step. This allows
 * CSS output to be gitignored while keeping Tailwind as the
 * authoring format.
 */
export interface LwcTailwindHooksOptions {
  /**
   * Path to the Tailwind CSS configuration file.
   * When omitted, the hook looks for `tailwind.config.js` or
   * `tailwind.config.ts` in the project root.
   */
  configPath?: string;

  /**
   * Glob patterns for LWC template/JS files to scan for Tailwind classes.
   * @default ['**\/lwc/**\/*.html', '**\/lwc/**\/*.js', '**\/lwc/**\/*.ts']
   */
  content?: string[];

  /**
   * Output CSS file name generated alongside each component.
   * When omitted, generates a `.css` file matching the component name.
   */
  outputFileName?: string;

  /**
   * Whether to apply LWC-specific CSS scoping to the generated output.
   * @default true
   */
  scopeStyles?: boolean;
}
