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
