/**
 * A simple identity tag for SOQL queries.
 * This enables IDE syntax highlighting and formatting for template literals.
 *
 * @param strings - The string parts of the template literal
 * @param values - The interpolated values
 * @returns The reconstructed string
 */
export function soql(strings: TemplateStringsArray, ...values: any[]): string {
  return strings.reduce((result, str, i) => result + str + (values[i] ?? ''), '');
}

/**
 * Escape a string value for use in a SOQL WHERE clause.
 *
 * Prevents SOQL injection by escaping single quotes.
 *
 * @param value - The raw string to escape
 * @returns The escaped string safe for SOQL interpolation
 */
export function escapeSOQL(value: string): string {
  return value.replaceAll("'", String.raw`\'`);
}
