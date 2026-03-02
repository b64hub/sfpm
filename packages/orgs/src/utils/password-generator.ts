import {User} from '@salesforce/core';

/**
 * Generate a secure random password meeting Salesforce requirements.
 *
 * Pure utility function with no side effects. Uses @salesforce/core's
 * password generation under the hood, which creates passwords meeting
 * Salesforce's complexity requirements.
 *
 * @param conditions - Optional password requirements (length, complexity, etc.)
 * @returns A randomly generated password string
 *
 * @example
 * ```ts
 * const password = await generatePassword();
 * console.log('Generated:', password);
 * ```
 */
export default async function generatePassword(conditions?: Record<string, unknown>): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- User.generatePasswordUtf8 accepts any
  const passwordBuffer = User.generatePasswordUtf8(conditions as any);

  return new Promise<string>(resolve => {
    passwordBuffer.value(buffer => {
      resolve(buffer.toString('utf8'));
    });
  });
}
