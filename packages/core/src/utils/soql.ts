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
