import {describe, expect, it} from 'vitest';

import generatePassword from '../../src/utils/password-generator.js';

// ============================================================================
// generatePassword Tests
// ============================================================================

describe('generatePassword', () => {
  describe('basic generation', () => {
    it('should generate a non-empty string', async () => {
      const password = await generatePassword();
      expect(password).toBeTruthy();
      expect(typeof password).toBe('string');
      expect(password.length).toBeGreaterThan(0);
    });

    it('should generate different passwords on successive calls', async () => {
      const passwords = await Promise.all([
        generatePassword(),
        generatePassword(),
        generatePassword(),
        generatePassword(),
        generatePassword(),
      ]);

      // All passwords should be unique (statistically almost certain)
      const uniquePasswords = new Set(passwords);
      expect(uniquePasswords.size).toBe(5);
    });
  });

  describe('password characteristics', () => {
    it('should generate passwords with reasonable length', async () => {
      const password = await generatePassword();
      // Salesforce tends to generate 12-16 char passwords
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password.length).toBeLessThanOrEqual(32);
    });

    it('should not contain only alphanumeric characters (likely has special chars)', async () => {
      // Generate multiple passwords to increase confidence
      const passwords = await Promise.all(Array.from({length: 10}, () => generatePassword()));

      const hasSpecialChar = passwords.some(pwd => /[^a-zA-Z0-9]/.test(pwd));
      expect(hasSpecialChar).toBe(true);
    });

    it('should contain a mix of character types', async () => {
      // Generate multiple to increase confidence of variety
      const passwords = await Promise.all(Array.from({length: 5}, () => generatePassword()));

      const hasUppercase = passwords.some(pwd => /[A-Z]/.test(pwd));
      const hasLowercase = passwords.some(pwd => /[a-z]/.test(pwd));
      const hasDigit = passwords.some(pwd => /[0-9]/.test(pwd));

      expect(hasUppercase).toBe(true);
      expect(hasLowercase).toBe(true);
      expect(hasDigit).toBe(true);
    });
  });

  describe('conditions parameter', () => {
    it('should accept valid conditions parameter', async () => {
      const conditions = {complexity: 1, length: 16};
      await expect(generatePassword(conditions)).resolves.toBeTruthy();
    });

    it('should handle undefined conditions (uses Salesforce defaults)', async () => {
      const password = await generatePassword();
      expect(password).toBeTruthy();
      expect(typeof password).toBe('string');
    });

    it('should handle omitted conditions parameter', async () => {
      const password = await generatePassword();
      expect(password).toBeTruthy();
      expect(typeof password).toBe('string');
    });
  });

  describe('reliability', () => {
    it('should generate passwords consistently', async () => {
      // Generate 20 passwords to verify reliability
      const promises = Array.from({length: 20}, () => generatePassword());
      const passwords = await Promise.all(promises);

      // All should be valid strings
      for (const pwd of passwords) {
        expect(typeof pwd).toBe('string');
        expect(pwd.length).toBeGreaterThan(0);
      }
    });
  });
});
