import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

import {ProfileCleaner, findProfilesDirectory, collectPackageComponents} from '../../src/profiles/profile-cleaner.js';
import {parseProfileXml} from '../../src/profiles/profile-xml.js';
import type {ComponentMap, Profile} from '../../src/profiles/types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const FULL_PROFILE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <applicationVisibilities>
        <application>standard__LightningSales</application>
        <default>true</default>
        <visible>true</visible>
    </applicationVisibilities>
    <applicationVisibilities>
        <application>MyCustomApp</application>
        <default>false</default>
        <visible>true</visible>
    </applicationVisibilities>
    <classAccesses>
        <apexClass>MyController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>OldController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <custom>true</custom>
    <customPermissions>
        <enabled>true</enabled>
        <name>MyCustomPerm</name>
    </customPermissions>
    <customPermissions>
        <enabled>true</enabled>
        <name>OldPerm</name>
    </customPermissions>
    <externalDataSourceAccesses>
        <enabled>true</enabled>
        <externalDataSource>MyDataSource</externalDataSource>
    </externalDataSourceAccesses>
    <fieldPermissions>
        <editable>true</editable>
        <field>Account.CustomField__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.OldField__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <flowAccesses>
        <enabled>true</enabled>
        <flow>My_Flow</flow>
    </flowAccesses>
    <flowAccesses>
        <enabled>true</enabled>
        <flow>Old_Flow</flow>
    </flowAccesses>
    <layoutAssignments>
        <layout>Account-Account Layout</layout>
    </layoutAssignments>
    <layoutAssignments>
        <layout>Contact-Contact Layout</layout>
        <recordType>Contact.Business</recordType>
    </layoutAssignments>
    <loginHours>
        <weekdayStart>480</weekdayStart>
        <weekdayEnd>1080</weekdayEnd>
    </loginHours>
    <loginIpRanges>
        <endAddress>255.255.255.255</endAddress>
        <startAddress>0.0.0.0</startAddress>
    </loginIpRanges>
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>true</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Account</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>false</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>OldObject__c</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
    <pageAccesses>
        <apexPage>MyPage</apexPage>
        <enabled>true</enabled>
    </pageAccesses>
    <recordTypeVisibilities>
        <default>true</default>
        <recordType>Account.Business</recordType>
        <visible>true</visible>
    </recordTypeVisibilities>
    <tabVisibilities>
        <tab>standard-Account</tab>
        <visibility>DefaultOn</visibility>
    </tabVisibilities>
    <tabVisibilities>
        <tab>MyCustomTab</tab>
        <visibility>DefaultOff</visibility>
    </tabVisibilities>
    <userLicense>Salesforce</userLicense>
    <userPermissions>
        <enabled>true</enabled>
        <name>ViewSetup</name>
    </userPermissions>
    <userPermissions>
        <enabled>false</enabled>
        <name>ManageUsers</name>
    </userPermissions>
</Profile>`;

function createTempDir(): string {
  const dir = join(tmpdir(), `sfpm-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, {recursive: true});
  return dir;
}

// ============================================================================
// ProfileCleaner
// ============================================================================

describe('ProfileCleaner', () => {
  describe('constructor', () => {
    it('should initialize with default options', () => {
      const cleaner = new ProfileCleaner();
      expect(cleaner.options.scope).toBe('source');
      expect(cleaner.options.removeLoginIpRanges).toBe(false);
      expect(cleaner.options.removeLoginHours).toBe(false);
      expect(cleaner.options.removeUnassignedUserPermissions).toBe(false);
    });

    it('should accept custom options', () => {
      const cleaner = new ProfileCleaner({
        scope: 'none',
        removeLoginIpRanges: true,
      });
      expect(cleaner.options.scope).toBe('none');
      expect(cleaner.options.removeLoginIpRanges).toBe(true);
    });
  });

  describe('cleanProfiles', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTempDir();
    });

    afterEach(() => {
      rmSync(testDir, {recursive: true, force: true});
    });

    it('should return empty array for nonexistent directory', async () => {
      const cleaner = new ProfileCleaner();
      const result = await cleaner.cleanProfiles('/nonexistent/path');
      expect(result).toEqual([]);
    });

    it('should return empty array when no profile files exist', async () => {
      writeFileSync(join(testDir, 'not-a-profile.txt'), 'hello');
      const cleaner = new ProfileCleaner();
      const result = await cleaner.cleanProfiles(testDir);
      expect(result).toEqual([]);
    });

    it('should clean profile files and return their paths', async () => {
      const profilePath = join(testDir, 'Admin.profile-meta.xml');
      writeFileSync(profilePath, FULL_PROFILE_XML);

      const cleaner = new ProfileCleaner({scope: 'none'});
      const result = await cleaner.cleanProfiles(testDir);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(profilePath);
    });

    it('should remove login IP ranges when option is set', async () => {
      const profilePath = join(testDir, 'Admin.profile-meta.xml');
      writeFileSync(profilePath, FULL_PROFILE_XML);

      const cleaner = new ProfileCleaner({scope: 'none', removeLoginIpRanges: true});
      await cleaner.cleanProfiles(testDir);

      const content = await readFile(profilePath, 'utf-8');
      expect(content).not.toContain('loginIpRanges');
      expect(content).not.toContain('0.0.0.0');
    });

    it('should remove login hours when option is set', async () => {
      const profilePath = join(testDir, 'Admin.profile-meta.xml');
      writeFileSync(profilePath, FULL_PROFILE_XML);

      const cleaner = new ProfileCleaner({scope: 'none', removeLoginHours: true});
      await cleaner.cleanProfiles(testDir);

      const content = await readFile(profilePath, 'utf-8');
      expect(content).not.toContain('loginHours');
    });

    it('should scope against package metadata', async () => {
      const profilePath = join(testDir, 'Admin.profile-meta.xml');
      writeFileSync(profilePath, FULL_PROFILE_XML);

      // Only these components exist in the package, keyed by section
      const metadata: ComponentMap = new Map([
        ['applicationVisibilities', new Set(['standard__LightningSales'])],
        ['classAccesses', new Set(['MyController'])],
        ['customPermissions', new Set(['MyCustomPerm'])],
        ['objectPermissions', new Set(['Account'])],
        ['fieldPermissions', new Set(['Account.CustomField__c'])],
        ['flowAccesses', new Set(['My_Flow'])],
        ['layoutAssignments', new Set(['Account-Account Layout'])],
        ['pageAccesses', new Set(['MyPage'])],
        ['recordTypeVisibilities', new Set(['Account.Business'])],
        ['tabVisibilities', new Set(['standard-Account'])],
      ]);

      const cleaner = new ProfileCleaner({scope: 'source'});
      await cleaner.cleanProfiles(testDir, metadata);

      const content = await readFile(profilePath, 'utf-8');
      const profile = parseProfileXml(content);

      // Kept
      expect(profile.applicationVisibilities).toHaveLength(1);
      expect(profile.applicationVisibilities![0].application).toBe('standard__LightningSales');

      expect(profile.classAccesses).toHaveLength(1);
      expect(profile.classAccesses![0].apexClass).toBe('MyController');

      expect(profile.customPermissions).toHaveLength(1);
      expect(profile.customPermissions![0].name).toBe('MyCustomPerm');

      expect(profile.flowAccesses).toHaveLength(1);
      expect(profile.flowAccesses![0].flow).toBe('My_Flow');

      expect(profile.objectPermissions).toHaveLength(1);
      expect(profile.objectPermissions![0].object).toBe('Account');

      expect(profile.fieldPermissions).toHaveLength(1);
      expect(profile.fieldPermissions![0].field).toBe('Account.CustomField__c');

      expect(profile.layoutAssignments).toHaveLength(1);
      expect(profile.layoutAssignments![0].layout).toBe('Account-Account Layout');

      expect(profile.pageAccesses).toHaveLength(1);
      expect(profile.pageAccesses![0].apexPage).toBe('MyPage');

      expect(profile.recordTypeVisibilities).toHaveLength(1);
      expect(profile.recordTypeVisibilities![0].recordType).toBe('Account.Business');

      expect(profile.tabVisibilities).toHaveLength(1);
      expect(profile.tabVisibilities![0].tab).toBe('standard-Account');
    });

    it('should clean multiple profile files', async () => {
      writeFileSync(join(testDir, 'Admin.profile-meta.xml'), FULL_PROFILE_XML);
      writeFileSync(join(testDir, 'Standard.profile-meta.xml'), FULL_PROFILE_XML);

      const cleaner = new ProfileCleaner({scope: 'none'});
      const result = await cleaner.cleanProfiles(testDir);

      expect(result).toHaveLength(2);
    });
  });

  describe('cleanProfile', () => {
    it('should not scope when scope is none', async () => {
      const cleaner = new ProfileCleaner({scope: 'none'});
      const profile = parseProfileXml(FULL_PROFILE_XML);

      const metadata: ComponentMap = new Map([['objectPermissions', new Set(['Account'])]]);
      await cleaner.cleanProfile(profile, metadata);

      // Nothing should be removed since scoping is disabled
      expect(profile.classAccesses).toHaveLength(2);
      expect(profile.applicationVisibilities).toHaveLength(2);
    });

    it('should not scope when metadata map is empty', async () => {
      const cleaner = new ProfileCleaner({scope: 'source'});
      const profile = parseProfileXml(FULL_PROFILE_XML);

      await cleaner.cleanProfile(profile, new Map());

      // Empty set means skip scoping
      expect(profile.classAccesses).toHaveLength(2);
    });

    it('should remove unassigned permissions from custom profiles', async () => {
      const cleaner = new ProfileCleaner({removeUnassignedUserPermissions: true, scope: 'none'});
      const profile = parseProfileXml(FULL_PROFILE_XML);

      await cleaner.cleanProfile(profile);

      // Only enabled permissions should remain
      expect(profile.userPermissions).toHaveLength(1);
      expect(profile.userPermissions![0].name).toBe('ViewSetup');
      expect(profile.userPermissions![0].enabled).toBe(true);
    });

    it('should remove all user permissions from standard profiles', async () => {
      const cleaner = new ProfileCleaner({removeUnassignedUserPermissions: true, scope: 'none'});
      const profile: Profile = {
        custom: false,
        userPermissions: [
          {name: 'ViewSetup', enabled: true},
          {name: 'ManageUsers', enabled: false},
        ],
      };

      await cleaner.cleanProfile(profile);

      expect(profile.userPermissions).toBeUndefined();
    });

    it('should handle profiles with no user permissions when stripping', async () => {
      const cleaner = new ProfileCleaner({removeUnassignedUserPermissions: true, scope: 'none'});
      const profile: Profile = {custom: true};

      await cleaner.cleanProfile(profile);

      expect(profile.userPermissions).toBeUndefined();
    });

    it('should keep field permissions when parent object is in metadata', async () => {
      const cleaner = new ProfileCleaner({scope: 'source'});
      const profile: Profile = {
        custom: true,
        fieldPermissions: [
          {field: 'Account.Name', editable: false, readable: true},
          {field: 'Contact.Email', editable: false, readable: true},
        ],
      };

      // Only Account object is in metadata (not 'Account.Name' directly)
      await cleaner.cleanProfile(profile, new Map([['objectPermissions', new Set(['Account'])]]));

      expect(profile.fieldPermissions).toHaveLength(1);
      expect(profile.fieldPermissions![0].field).toBe('Account.Name');
    });

    it('should handle layoutAssignments with recordType check', async () => {
      const cleaner = new ProfileCleaner({scope: 'source'});
      const profile: Profile = {
        custom: true,
        layoutAssignments: [
          {layout: 'Account-Account Layout'},
          {layout: 'Contact-Contact Layout', recordType: 'Contact.Business'},
          {layout: 'Lead-Lead Layout', recordType: 'Lead.MissingRT'},
        ],
      };

      const metadata: ComponentMap = new Map([
        ['layoutAssignments', new Set(['Account-Account Layout', 'Contact-Contact Layout', 'Lead-Lead Layout'])],
        ['recordTypeVisibilities', new Set(['Contact.Business'])],
        // Note: Lead.MissingRT is NOT in metadata
      ]);

      await cleaner.cleanProfile(profile, metadata);

      expect(profile.layoutAssignments).toHaveLength(2);
      expect(profile.layoutAssignments![0].layout).toBe('Account-Account Layout');
      expect(profile.layoutAssignments![1].layout).toBe('Contact-Contact Layout');
    });

    it('should apply all options together', async () => {
      const cleaner = new ProfileCleaner({
        scope: 'source',
        removeLoginHours: true,
        removeLoginIpRanges: true,
        removeUnassignedUserPermissions: true,
      });

      const profile = parseProfileXml(FULL_PROFILE_XML);
      const metadata: ComponentMap = new Map([
        ['objectPermissions', new Set(['Account'])],
        ['classAccesses', new Set(['MyController'])],
        ['applicationVisibilities', new Set(['standard__LightningSales'])],
      ]);

      await cleaner.cleanProfile(profile, metadata);

      // Reconciliation applied
      expect(profile.classAccesses).toHaveLength(1);
      // Login sections removed
      expect(profile.loginHours).toBeUndefined();
      expect(profile.loginIpRanges).toBeUndefined();
      // Unassigned permissions removed (custom profile keeps enabled only)
      expect(profile.userPermissions).toHaveLength(1);
      expect(profile.userPermissions![0].enabled).toBe(true);
    });

    it('should skip scoping for sections not present in profile', async () => {
      const cleaner = new ProfileCleaner({scope: 'source'});
      const profile: Profile = {
        custom: true,
        userLicense: 'Salesforce',
      };

      // Should not throw
      await cleaner.cleanProfile(profile, new Map([['objectPermissions', new Set(['Account'])]]));

      expect(profile.custom).toBe(true);
    });

    // ========================================================================
    // Org-aware scoping
    // ========================================================================

    describe('with org components', () => {
      function createOrgComponents(
        orgData: Record<string, string[]>,
      ): ComponentMap {
        return new Map(
          Object.entries(orgData).map(([section, names]) => [section, new Set(names)]),
        );
      }

      it('should keep entries found in org but not in source', async () => {
        const cleaner = new ProfileCleaner({scope: 'source'});
        const profile: Profile = {
          classAccesses: [
            {apexClass: 'MyController', enabled: true},
            {apexClass: 'OrgOnlyClass', enabled: true},
            {apexClass: 'DeletedClass', enabled: true},
          ],
        };

        // Source only has MyController, org has OrgOnlyClass
        const sourceMetadata: ComponentMap = new Map([['classAccesses', new Set(['MyController'])]]);
        const orgComponents = createOrgComponents({
          classAccesses: ['OrgOnlyClass'],
        });

        await cleaner.cleanProfile(profile, sourceMetadata, orgComponents);

        expect(profile.classAccesses).toHaveLength(2);
        const names = profile.classAccesses!.map((c) => c.apexClass);
        expect(names).toContain('MyController');
        expect(names).toContain('OrgOnlyClass');
        expect(names).not.toContain('DeletedClass');
      });

      it('should preserve standard objects from org during scoping', async () => {
        const cleaner = new ProfileCleaner({scope: 'source'});
        const profile: Profile = {
          objectPermissions: [
            {object: 'Account', allowCreate: true, allowDelete: true, allowEdit: true, allowRead: true, modifyAllRecords: false, viewAllRecords: false},
            {object: 'Contact', allowCreate: true, allowDelete: false, allowEdit: true, allowRead: true, modifyAllRecords: false, viewAllRecords: false},
            {object: 'Deleted__c', allowCreate: false, allowDelete: false, allowEdit: false, allowRead: true, modifyAllRecords: false, viewAllRecords: false},
          ],
        };

        // Only Account in source, but Contact is a standard object in the org
        const sourceMetadata: ComponentMap = new Map([['objectPermissions', new Set(['Account'])]]);
        const orgComponents = createOrgComponents({
          objectPermissions: ['Account', 'Contact', 'Lead', 'Opportunity'],
        });

        await cleaner.cleanProfile(profile, sourceMetadata, orgComponents);

        expect(profile.objectPermissions).toHaveLength(2);
        const objects = profile.objectPermissions!.map((o) => o.object);
        expect(objects).toContain('Account');
        expect(objects).toContain('Contact');
        expect(objects).not.toContain('Deleted__c');
      });

      it('should merge org fields with source metadata for fieldPermissions', async () => {
        const cleaner = new ProfileCleaner({scope: 'source'});
        const profile: Profile = {
          fieldPermissions: [
            {field: 'Account.Name', editable: false, readable: true},
            {field: 'Account.Industry', editable: false, readable: true},
            {field: 'Deleted__c.Field__c', editable: false, readable: true},
          ],
        };

        // Source has Account object, org has Account.Name and Account.Industry
        const sourceMetadata: ComponentMap = new Map([['objectPermissions', new Set(['Account'])]]);
        const orgComponents = createOrgComponents({
          fieldPermissions: ['Account.Name', 'Account.Industry'],
        });

        await cleaner.cleanProfile(profile, sourceMetadata, orgComponents);

        // All Account fields kept — Account.Name and Account.Industry via parent + org
        expect(profile.fieldPermissions).toHaveLength(2);
        const fields = profile.fieldPermissions!.map((f) => f.field);
        expect(fields).toContain('Account.Name');
        expect(fields).toContain('Account.Industry');
        expect(fields).not.toContain('Deleted__c.Field__c');
      });

      it('should fall back to source-only when org components are empty', async () => {
        const cleaner = new ProfileCleaner({scope: 'source'});
        const profile: Profile = {
          classAccesses: [
            {apexClass: 'MyController', enabled: true},
            {apexClass: 'OtherClass', enabled: true},
          ],
        };

        const sourceMetadata: ComponentMap = new Map([['classAccesses', new Set(['MyController'])]]);
        const orgComponents = createOrgComponents({}); // Empty org data

        await cleaner.cleanProfile(profile, sourceMetadata, orgComponents);

        expect(profile.classAccesses).toHaveLength(1);
        expect(profile.classAccesses![0].apexClass).toBe('MyController');
      });

      it('should work with org components for layout recordType checks', async () => {
        const cleaner = new ProfileCleaner({scope: 'source'});
        const profile: Profile = {
          layoutAssignments: [
            {layout: 'Account-Account Layout'},
            {layout: 'Contact-Contact Layout', recordType: 'Contact.Business'},
          ],
        };

        // Source has account layout, org has contact layout + record type
        const sourceMetadata: ComponentMap = new Map([
          ['layoutAssignments', new Set(['Account-Account Layout'])],
        ]);
        const orgComponents = createOrgComponents({
          layoutAssignments: ['Contact-Contact Layout'],
          recordTypeVisibilities: ['Contact.Business'],
        });

        await cleaner.cleanProfile(profile, sourceMetadata, orgComponents);

        expect(profile.layoutAssignments).toHaveLength(2);
      });
    });
  });
});

describe('findProfilesDirectory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    rmSync(testDir, {recursive: true, force: true});
  });

  it('should find profiles directory at package root', () => {
    const profilesDir = join(testDir, 'profiles');
    mkdirSync(profilesDir);

    expect(findProfilesDirectory(testDir)).toBe(profilesDir);
  });

  it('should find profiles in main/default/profiles', () => {
    const profilesDir = join(testDir, 'main', 'default', 'profiles');
    mkdirSync(profilesDir, {recursive: true});

    expect(findProfilesDirectory(testDir)).toBe(profilesDir);
  });

  it('should return undefined when no profiles directory exists', () => {
    expect(findProfilesDirectory(testDir)).toBeUndefined();
  });

  it('should prefer root-level profiles directory', () => {
    const rootProfiles = join(testDir, 'profiles');
    mkdirSync(rootProfiles);
    mkdirSync(join(testDir, 'main', 'default', 'profiles'), {recursive: true});

    expect(findProfilesDirectory(testDir)).toBe(rootProfiles);
  });
});

// ============================================================================
// collectPackageComponents
// ============================================================================

describe('collectPackageComponents', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    rmSync(testDir, {recursive: true, force: true});
  });

  it('should collect class names into classAccesses section', async () => {
    mkdirSync(join(testDir, 'classes'), {recursive: true});
    writeFileSync(join(testDir, 'classes', 'MyController.cls-meta.xml'), '<ApexClass/>');
    writeFileSync(join(testDir, 'classes', 'OtherClass.cls-meta.xml'), '<ApexClass/>');

    const components = await collectPackageComponents(testDir);

    const classes = components.get('classAccesses');
    expect(classes).toBeDefined();
    expect(classes!.has('MyController')).toBe(true);
    expect(classes!.has('OtherClass')).toBe(true);
  });

  it('should collect application names into applicationVisibilities section', async () => {
    mkdirSync(join(testDir, 'applications'), {recursive: true});
    writeFileSync(join(testDir, 'applications', 'MyApp.app-meta.xml'), '<CustomApplication/>');

    const components = await collectPackageComponents(testDir);

    expect(components.get('applicationVisibilities')!.has('MyApp')).toBe(true);
  });

  it('should collect page names into pageAccesses section', async () => {
    mkdirSync(join(testDir, 'pages'), {recursive: true});
    writeFileSync(join(testDir, 'pages', 'MyPage.page-meta.xml'), '<ApexPage/>');

    const components = await collectPackageComponents(testDir);

    expect(components.get('pageAccesses')!.has('MyPage')).toBe(true);
  });

  it('should collect flow names into flowAccesses section', async () => {
    mkdirSync(join(testDir, 'flows'), {recursive: true});
    writeFileSync(join(testDir, 'flows', 'My_Flow.flow-meta.xml'), '<Flow/>');

    const components = await collectPackageComponents(testDir);

    expect(components.get('flowAccesses')!.has('My_Flow')).toBe(true);
  });

  it('should collect layout names into layoutAssignments section', async () => {
    mkdirSync(join(testDir, 'layouts'), {recursive: true});
    writeFileSync(join(testDir, 'layouts', 'Account-Account Layout.layout-meta.xml'), '<Layout/>');

    const components = await collectPackageComponents(testDir);

    expect(components.get('layoutAssignments')!.has('Account-Account Layout')).toBe(true);
  });

  it('should collect tab names into tabVisibilities section', async () => {
    mkdirSync(join(testDir, 'tabs'), {recursive: true});
    writeFileSync(join(testDir, 'tabs', 'MyTab.tab-meta.xml'), '<CustomTab/>');

    const components = await collectPackageComponents(testDir);

    expect(components.get('tabVisibilities')!.has('MyTab')).toBe(true);
  });

  it('should collect objects, fields, and record types into separate sections', async () => {
    const objDir = join(testDir, 'objects', 'Account');
    mkdirSync(join(objDir, 'fields'), {recursive: true});
    mkdirSync(join(objDir, 'recordTypes'), {recursive: true});
    writeFileSync(join(objDir, 'Account.object-meta.xml'), '<CustomObject/>');
    writeFileSync(join(objDir, 'fields', 'CustomField__c.field-meta.xml'), '<CustomField/>');
    writeFileSync(join(objDir, 'recordTypes', 'Business.recordType-meta.xml'), '<RecordType/>');

    const components = await collectPackageComponents(testDir);

    expect(components.get('objectPermissions')!.has('Account')).toBe(true);
    expect(components.get('fieldPermissions')!.has('Account.CustomField__c')).toBe(true);
    expect(components.get('recordTypeVisibilities')!.has('Account.Business')).toBe(true);
  });

  it('should handle empty package directory', async () => {
    const components = await collectPackageComponents(testDir);

    expect(components.size).toBe(0);
  });

  it('should collect customPermission names', async () => {
    mkdirSync(join(testDir, 'customPermissions'), {recursive: true});
    writeFileSync(join(testDir, 'customPermissions', 'MyPerm.customPermission-meta.xml'), '<CustomPermission/>');

    const components = await collectPackageComponents(testDir);

    expect(components.get('customPermissions')!.has('MyPerm')).toBe(true);
  });

  it('should collect externalDataSource names', async () => {
    mkdirSync(join(testDir, 'dataSources'), {recursive: true});
    writeFileSync(join(testDir, 'dataSources', 'MySource.dataSource-meta.xml'), '<ExternalDataSource/>');

    const components = await collectPackageComponents(testDir);

    expect(components.get('externalDataSourceAccesses')!.has('MySource')).toBe(true);
  });
});
