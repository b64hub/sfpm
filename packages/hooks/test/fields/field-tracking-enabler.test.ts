import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {FieldTrackingEnabler} from '../../src/fields/field-tracking-enabler.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

function createMockConnection(overrides?: {
  metadataRead?: any;
  metadataUpdate?: any;
  queryResult?: any;
}) {
  return {
    metadata: {
      read: vi.fn().mockResolvedValue(overrides?.metadataRead ?? []),
      update: vi.fn().mockResolvedValue(overrides?.metadataUpdate ?? []),
    },
    query: vi.fn().mockResolvedValue({records: overrides?.queryResult ?? []}),
  } as any;
}

// ============================================================================
// Tests
// ============================================================================

describe('FieldTrackingEnabler', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createLogger();
  });

  // --------------------------------------------------------------------------
  // Empty input
  // --------------------------------------------------------------------------

  describe('empty input', () => {
    it('should return success with zero counts for empty field list', async () => {
      const conn = createMockConnection();
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      const result = await enabler.enableTracking([]);

      expect(result).toEqual({fieldsEnabled: 0, fieldsSkipped: 0, success: true});
      expect(conn.query).not.toHaveBeenCalled();
      expect(conn.metadata.read).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Field History Tracking
  // --------------------------------------------------------------------------

  describe('history tracking', () => {
    it('should query with IsFieldHistoryTracked filter', async () => {
      const conn = createMockConnection();
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      await enabler.enableTracking(['Account.MyField__c']);

      expect(conn.query).toHaveBeenCalledWith(
        expect.stringContaining('IsFieldHistoryTracked = true'),
      );
    });

    it('should set trackHistory property when updating', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Account.MyField__c', trackHistory: false}],
        metadataUpdate: [{fullName: 'Account.MyField__c', success: true}],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      await enabler.enableTracking(['Account.MyField__c']);

      const updateCall = conn.metadata.update.mock.calls[0];
      expect(updateCall[0]).toBe('CustomField');
      expect(updateCall[1][0].trackHistory).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Feed Tracking
  // --------------------------------------------------------------------------

  describe('feed tracking', () => {
    it('should query with IsFeedEnabled filter', async () => {
      const conn = createMockConnection();
      const enabler = new FieldTrackingEnabler(conn, 'feed', logger);

      await enabler.enableTracking(['Account.MyField__c']);

      expect(conn.query).toHaveBeenCalledWith(
        expect.stringContaining('IsFeedEnabled = true'),
      );
    });

    it('should set trackFeedHistory property when updating', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Account.MyField__c', trackFeedHistory: false}],
        metadataUpdate: [{fullName: 'Account.MyField__c', success: true}],
      });
      const enabler = new FieldTrackingEnabler(conn, 'feed', logger);

      await enabler.enableTracking(['Account.MyField__c']);

      const updateCall = conn.metadata.update.mock.calls[0];
      expect(updateCall[0]).toBe('CustomField');
      expect(updateCall[1][0].trackFeedHistory).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Already Enabled Filtering
  // --------------------------------------------------------------------------

  describe('already-enabled filtering', () => {
    it('should skip fields already enabled in org', async () => {
      const conn = createMockConnection({
        queryResult: [
          {EntityDefinition: {QualifiedApiName: 'Account'}, QualifiedApiName: 'MyField__c'},
        ],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      const result = await enabler.enableTracking(['Account.MyField__c']);

      expect(result).toEqual({fieldsEnabled: 0, fieldsSkipped: 1, success: true});
      expect(conn.metadata.read).not.toHaveBeenCalled();
    });

    it('should only process fields not already enabled', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Contact.Status__c', trackHistory: false}],
        metadataUpdate: [{fullName: 'Contact.Status__c', success: true}],
        queryResult: [
          {EntityDefinition: {QualifiedApiName: 'Account'}, QualifiedApiName: 'MyField__c'},
        ],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      const result = await enabler.enableTracking([
        'Account.MyField__c',
        'Contact.Status__c',
      ]);

      expect(result.fieldsEnabled).toBe(1);
      expect(result.fieldsSkipped).toBe(1);
      // Should only read the unskipped field
      expect(conn.metadata.read).toHaveBeenCalledWith('CustomField', ['Contact.Status__c']);
    });
  });

  // --------------------------------------------------------------------------
  // SOQL Query Construction
  // --------------------------------------------------------------------------

  describe('query construction', () => {
    it('should build IN clause with unique object names', async () => {
      const conn = createMockConnection();
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      await enabler.enableTracking([
        'Account.FieldA__c',
        'Account.FieldB__c',
        'Contact.FieldC__c',
      ]);

      const query = conn.query.mock.calls[0][0] as string;
      expect(query).toContain("'Account'");
      expect(query).toContain("'Contact'");
      expect(query).toContain('EntityDefinitionId IN');
    });
  });

  // --------------------------------------------------------------------------
  // Metadata Read/Update
  // --------------------------------------------------------------------------

  describe('metadata operations', () => {
    it('should handle single field (non-array) metadata read response', async () => {
      // Metadata API returns a single object when only one field is read
      const conn = createMockConnection({
        metadataRead: {fullName: 'Account.MyField__c', trackHistory: false},
        metadataUpdate: {fullName: 'Account.MyField__c', success: true},
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      const result = await enabler.enableTracking(['Account.MyField__c']);

      expect(result.fieldsEnabled).toBe(1);
    });

    it('should handle single update result (non-array)', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Account.MyField__c'}],
        metadataUpdate: {fullName: 'Account.MyField__c', success: true},
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      const result = await enabler.enableTracking(['Account.MyField__c']);

      expect(result.fieldsEnabled).toBe(1);
    });

    it('should skip fields not found in org (empty fullName)', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: ''}],
        metadataUpdate: [],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      const result = await enabler.enableTracking(['Account.NonExistent__c']);

      expect(result.fieldsEnabled).toBe(0);
      expect(conn.metadata.update).not.toHaveBeenCalled();
    });

    it('should skip null entries in metadata read response', async () => {
      const conn = createMockConnection({
        metadataRead: [null, {fullName: 'Account.MyField__c'}],
        metadataUpdate: [{fullName: 'Account.MyField__c', success: true}],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      const result = await enabler.enableTracking([
        'Account.Gone__c',
        'Account.MyField__c',
      ]);

      expect(result.fieldsEnabled).toBe(1);
      // Should only contain the valid field in the update
      expect(conn.metadata.update.mock.calls[0][1]).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Failure Handling
  // --------------------------------------------------------------------------

  describe('failure handling', () => {
    it('should count failed updates and warn', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Account.MyField__c'}],
        metadataUpdate: [{
          errors: [{message: 'Cannot enable tracking'}],
          fullName: 'Account.MyField__c',
          success: false,
        }],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      const result = await enabler.enableTracking(['Account.MyField__c']);

      expect(result.fieldsEnabled).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot enable tracking'),
      );
    });

    it('should format multiple errors separated by semicolons', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Account.MyField__c'}],
        metadataUpdate: [{
          errors: [{message: 'Error 1'}, {message: 'Error 2'}],
          fullName: 'Account.MyField__c',
          success: false,
        }],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      await enabler.enableTracking(['Account.MyField__c']);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Error 1; Error 2'),
      );
    });

    it('should show Unknown error when no errors property', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Account.MyField__c'}],
        metadataUpdate: [{fullName: 'Account.MyField__c', success: false}],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      await enabler.enableTracking(['Account.MyField__c']);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unknown error'),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Batching
  // --------------------------------------------------------------------------

  describe('batching', () => {
    it('should process fields in batches of 10', async () => {
      // Create 15 fields — should result in 2 batches (10 + 5)
      const fieldNames = Array.from({length: 15}, (_, i) => `Account.Field${i}__c`);

      const conn = createMockConnection();
      // Return valid fields for each read call
      conn.metadata.read
        .mockResolvedValueOnce(
          fieldNames.slice(0, 10).map(f => ({fullName: f})),
        )
        .mockResolvedValueOnce(
          fieldNames.slice(10).map(f => ({fullName: f})),
        );
      conn.metadata.update
        .mockResolvedValueOnce(
          fieldNames.slice(0, 10).map(f => ({fullName: f, success: true})),
        )
        .mockResolvedValueOnce(
          fieldNames.slice(10).map(f => ({fullName: f, success: true})),
        );

      const enabler = new FieldTrackingEnabler(conn, 'history', logger);
      const result = await enabler.enableTracking(fieldNames);

      expect(conn.metadata.read).toHaveBeenCalledTimes(2);
      expect(conn.metadata.update).toHaveBeenCalledTimes(2);
      expect(result.fieldsEnabled).toBe(15);
    });
  });

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------

  describe('logging', () => {
    it('should log debug messages when fields tracked', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Account.MyField__c'}],
        metadataUpdate: [{fullName: 'Account.MyField__c', success: true}],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history', logger);

      await enabler.enableTracking(['Account.MyField__c']);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('enabling tracking on 1 field(s)'),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("enabled on 'Account.MyField__c'"),
      );
    });

    it('should use correct log prefix per tracking type', async () => {
      const conn = createMockConnection();

      const historyEnabler = new FieldTrackingEnabler(conn, 'history', logger);
      await historyEnabler.enableTracking(['Account.A__c']);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('FieldHistoryTracking:'),
      );

      vi.clearAllMocks();

      const feedEnabler = new FieldTrackingEnabler(conn, 'feed', logger);
      await feedEnabler.enableTracking(['Account.A__c']);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('FeedTracking:'),
      );
    });

    it('should work without a logger', async () => {
      const conn = createMockConnection({
        metadataRead: [{fullName: 'Account.MyField__c'}],
        metadataUpdate: [{fullName: 'Account.MyField__c', success: true}],
      });
      const enabler = new FieldTrackingEnabler(conn, 'history');

      // Should not throw
      const result = await enabler.enableTracking(['Account.MyField__c']);
      expect(result.fieldsEnabled).toBe(1);
    });
  });
});
