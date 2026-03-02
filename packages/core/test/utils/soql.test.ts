import {describe, expect, it} from 'vitest';

import {escapeSOQL, soql} from '../../src/utils/soql.js';

// ============================================================================
// escapeSOQL Tests
// ============================================================================

describe('escapeSOQL', () => {
  describe('basic escaping', () => {
    it('should escape single quotes', () => {
      expect(escapeSOQL("O'Reilly")).toBe(String.raw`O\'Reilly`);
    });

    it('should escape multiple single quotes', () => {
      expect(escapeSOQL("It's Bob's test")).toBe(String.raw`It\'s Bob\'s test`);
    });

    it('should return unchanged string without quotes', () => {
      expect(escapeSOQL('plain text')).toBe('plain text');
    });

    it('should handle empty string', () => {
      expect(escapeSOQL('')).toBe('');
    });
  });

  describe('injection prevention', () => {
    it('should prevent basic injection attempt', () => {
      const malicious = "' OR 1=1 --";
      const escaped = escapeSOQL(malicious);
      expect(escaped).toBe(String.raw`\' OR 1=1 --`);
      // Check that all single quotes are now escaped
      expect(escaped.match(/[^\\]'/)).toBeNull(); // No unescaped quotes
    });

    it('should prevent multi-quote injection', () => {
      const malicious = "'; DROP TABLE Users; --";
      const escaped = escapeSOQL(malicious);
      expect(escaped).toBe(String.raw`\'; DROP TABLE Users; --`);
    });

    it('should handle consecutive quotes', () => {
      expect(escapeSOQL("test''value")).toBe(String.raw`test\'\'value`);
    });
  });

  describe('edge cases', () => {
    it('should handle string with only quotes', () => {
      expect(escapeSOQL("'''")).toBe(String.raw`\'\'\'`);
    });

    it('should handle unicode characters', () => {
      expect(escapeSOQL("Test's value 🎉")).toBe(String.raw`Test\'s value 🎉`);
    });

    it('should handle newlines and special whitespace', () => {
      const input = "Line 1's\nLine 2's\tTabbed";
      const expected = String.raw`Line 1\'s` + '\n' + String.raw`Line 2\'s` + '\tTabbed';
      expect(escapeSOQL(input)).toBe(expected);
    });

    it('should preserve backslashes that are not quote escapes', () => {
      // Note: In SOQL, we only escape quotes. Other backslashes pass through.
      expect(escapeSOQL(String.raw`path\to\file`)).toBe(String.raw`path\to\file`);
    });
  });
});

// ============================================================================
// soql Template Tag Tests
// ============================================================================

describe('soql', () => {
  describe('template literal reconstruction', () => {
    it('should reconstruct plain string without interpolation', () => {
      const query = soql`SELECT Id FROM Account`;
      expect(query).toBe('SELECT Id FROM Account');
    });

    it('should interpolate single value', () => {
      const accountName = 'Acme Corp';
      const query = soql`SELECT Id FROM Account WHERE Name = '${accountName}'`;
      expect(query).toBe("SELECT Id FROM Account WHERE Name = 'Acme Corp'");
    });

    it('should interpolate multiple values', () => {
      const name = 'Test';
      const status = 'Active';
      const limit = 10;
      const query = soql`SELECT Id FROM Account WHERE Name = '${name}' AND Status = '${status}' LIMIT ${limit}`;
      expect(query).toBe("SELECT Id FROM Account WHERE Name = 'Test' AND Status = 'Active' LIMIT 10");
    });

    it('should handle numeric interpolations', () => {
      const amount = 1000;
      const query = soql`SELECT Id FROM Opportunity WHERE Amount > ${amount}`;
      expect(query).toBe('SELECT Id FROM Opportunity WHERE Amount > 1000');
    });

    it('should handle boolean interpolations', () => {
      const active = true;
      const query = soql`SELECT Id FROM Account WHERE IsActive = ${active}`;
      expect(query).toBe('SELECT Id FROM Account WHERE IsActive = true');
    });
  });

  describe('escaping integration', () => {
    it('should work with escapeSOQL for safe interpolation', () => {
      const userInput = "O'Reilly";
      const query = soql`SELECT Id FROM Account WHERE Name = '${escapeSOQL(userInput)}'`;
      expect(query).toBe(String.raw`SELECT Id FROM Account WHERE Name = 'O\'Reilly'`);
    });

    it('should protect against injection when using escapeSOQL', () => {
      const maliciousInput = "'; DROP TABLE Users; --";
      const query = soql`SELECT Id FROM Account WHERE Name = '${escapeSOQL(maliciousInput)}'`;
      expect(query).toBe(String.raw`SELECT Id FROM Account WHERE Name = '\'; DROP TABLE Users; --'`);
      // Query structure is preserved - the malicious SQL is now just a literal string value
    });

    it('should handle multiple escaped values in one query', () => {
      const firstName = "Bob's";
      const lastName = "O'Neill";
      const query = soql`
        SELECT Id FROM Contact 
        WHERE FirstName = '${escapeSOQL(firstName)}' 
        AND LastName = '${escapeSOQL(lastName)}'
      `;
      expect(query).toContain(String.raw`FirstName = 'Bob\'s'`);
      expect(query).toContain(String.raw`LastName = 'O\'Neill'`);
    });
  });

  describe('edge cases', () => {
    it('should handle null values', () => {
      const value = null;
      const query = soql`SELECT Id FROM Account WHERE Name = ${value}`;
      expect(query).toBe('SELECT Id FROM Account WHERE Name = ');
    });

    it('should handle undefined values', () => {
      const value = undefined;
      const query = soql`SELECT Id FROM Account WHERE Name = ${value}`;
      expect(query).toBe('SELECT Id FROM Account WHERE Name = ');
    });

    it('should handle empty string interpolation', () => {
      const value = '';
      const query = soql`SELECT Id FROM Account WHERE Name = '${value}'`;
      expect(query).toBe("SELECT Id FROM Account WHERE Name = ''");
    });

    it('should handle complex nested query', () => {
      const status = 'Open';
      const amount = 5000;
      const query = soql`
        SELECT Id, Name, 
          (SELECT FirstName, LastName FROM Contacts)
        FROM Account 
        WHERE Status = '${status}' 
        AND AnnualRevenue > ${amount}
        ORDER BY CreatedDate DESC
        LIMIT 100
      `;
      expect(query).toContain("Status = 'Open'");
      expect(query).toContain('AnnualRevenue > 5000');
      expect(query).toContain('SELECT Id, Name,');
    });
  });

  describe('real-world query patterns', () => {
    it('should handle tag-based query from DevHubService', () => {
      const tag = 'dev-pool';
      const query = soql`
        SELECT Id, SignupUsername, OrgName, Status, ExpirationDate, CreatedDate
        FROM ScratchOrgInfo
        WHERE Tag__c = '${escapeSOQL(tag)}'
        ORDER BY CreatedDate DESC
      `;
      expect(query).toContain("Tag__c = 'dev-pool'");
    });

    it('should handle username-based query', () => {
      const username = "test-user+special'char@example.com";
      const query = soql`
        SELECT Id, Email 
        FROM User 
        WHERE Username = '${escapeSOQL(username)}'
      `;
      expect(query).toContain(String.raw`Username = 'test-user+special\'char@example.com'`);
    });

    it('should handle date and status filters', () => {
      const status = 'Active';
      const days = 7;
      const query = soql`
        SELECT Id, OrgName 
        FROM ScratchOrgInfo 
        WHERE Status = '${status}' 
        AND CreatedDate = LAST_N_DAYS:${days}
      `;
      expect(query).toContain("Status = 'Active'");
      expect(query).toContain('LAST_N_DAYS:7');
    });
  });
});
