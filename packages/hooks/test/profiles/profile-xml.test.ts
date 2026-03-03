import {describe, it, expect} from 'vitest';

import {buildProfileXml, parseProfileXml} from '../../src/profiles/profile-xml.js';
import type {Profile} from '../../src/profiles/types.js';

const SAMPLE_PROFILE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <applicationVisibilities>
        <application>standard__LightningSales</application>
        <default>true</default>
        <visible>true</visible>
    </applicationVisibilities>
    <applicationVisibilities>
        <application>standard__Marketing</application>
        <default>false</default>
        <visible>false</visible>
    </applicationVisibilities>
    <classAccesses>
        <apexClass>MyController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <custom>true</custom>
    <fieldPermissions>
        <editable>true</editable>
        <field>Account.CustomField__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.Email</field>
        <readable>true</readable>
    </fieldPermissions>
    <flowAccesses>
        <enabled>true</enabled>
        <flow>My_Flow</flow>
    </flowAccesses>
    <layoutAssignments>
        <layout>Account-Account Layout</layout>
    </layoutAssignments>
    <layoutAssignments>
        <layout>Contact-Contact Layout</layout>
        <recordType>Contact.Business</recordType>
    </layoutAssignments>
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

const MINIMAL_PROFILE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <custom>false</custom>
    <userLicense>Salesforce</userLicense>
</Profile>`;

const SINGLE_CLASS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>SingleClass</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <custom>true</custom>
</Profile>`;

describe('parseProfileXml', () => {
  it('should parse a complete profile XML', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.custom).toBe(true);
    expect(profile.userLicense).toBe('Salesforce');
  });

  it('should parse applicationVisibilities as array', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.applicationVisibilities).toHaveLength(2);
    expect(profile.applicationVisibilities![0]).toEqual({
      application: 'standard__LightningSales',
      default: true,
      visible: true,
    });
    expect(profile.applicationVisibilities![1]).toEqual({
      application: 'standard__Marketing',
      default: false,
      visible: false,
    });
  });

  it('should parse classAccesses as array', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.classAccesses).toHaveLength(1);
    expect(profile.classAccesses![0]).toEqual({
      apexClass: 'MyController',
      enabled: true,
    });
  });

  it('should parse fieldPermissions as array', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.fieldPermissions).toHaveLength(2);
    expect(profile.fieldPermissions![0].field).toBe('Account.CustomField__c');
    expect(profile.fieldPermissions![0].editable).toBe(true);
    expect(profile.fieldPermissions![0].readable).toBe(true);
  });

  it('should parse layoutAssignments with optional recordType', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.layoutAssignments).toHaveLength(2);
    expect(profile.layoutAssignments![0].layout).toBe('Account-Account Layout');
    expect(profile.layoutAssignments![0].recordType).toBeUndefined();
    expect(profile.layoutAssignments![1].recordType).toBe('Contact.Business');
  });

  it('should parse userPermissions as array with boolean enabled', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.userPermissions).toHaveLength(2);
    expect(profile.userPermissions![0]).toEqual({enabled: true, name: 'ViewSetup'});
    expect(profile.userPermissions![1]).toEqual({enabled: false, name: 'ManageUsers'});
  });

  it('should parse loginIpRanges as array', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.loginIpRanges).toHaveLength(1);
    expect(profile.loginIpRanges![0].startAddress).toBe('0.0.0.0');
    expect(profile.loginIpRanges![0].endAddress).toBe('255.255.255.255');
  });

  it('should handle minimal profile', () => {
    const profile = parseProfileXml(MINIMAL_PROFILE_XML);

    expect(profile.custom).toBe(false);
    expect(profile.userLicense).toBe('Salesforce');
    expect(profile.classAccesses).toBeUndefined();
    expect(profile.applicationVisibilities).toBeUndefined();
  });

  it('should wrap single-element arrays as arrays', () => {
    const profile = parseProfileXml(SINGLE_CLASS_XML);

    expect(profile.classAccesses).toHaveLength(1);
    expect(Array.isArray(profile.classAccesses)).toBe(true);
    expect(profile.classAccesses![0].apexClass).toBe('SingleClass');
  });

  it('should return empty profile for invalid XML', () => {
    const profile = parseProfileXml('<NotAProfile><foo>bar</foo></NotAProfile>');

    expect(profile).toEqual({});
  });

  it('should parse objectPermissions correctly', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.objectPermissions).toHaveLength(1);
    expect(profile.objectPermissions![0]).toEqual({
      allowCreate: true,
      allowDelete: true,
      allowEdit: true,
      allowRead: true,
      modifyAllRecords: false,
      object: 'Account',
      viewAllRecords: false,
    });
  });

  it('should parse tabVisibilities', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.tabVisibilities).toHaveLength(1);
    expect(profile.tabVisibilities![0]).toEqual({
      tab: 'standard-Account',
      visibility: 'DefaultOn',
    });
  });

  it('should parse recordTypeVisibilities', () => {
    const profile = parseProfileXml(SAMPLE_PROFILE_XML);

    expect(profile.recordTypeVisibilities).toHaveLength(1);
    expect(profile.recordTypeVisibilities![0]).toEqual({
      default: true,
      recordType: 'Account.Business',
      visible: true,
    });
  });
});

describe('buildProfileXml', () => {
  it('should produce valid XML with namespace', () => {
    const profile: Profile = {
      custom: true,
      userLicense: 'Salesforce',
    };

    const xml = buildProfileXml(profile);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns="http://soap.sforce.com/2006/04/metadata"');
    expect(xml).toContain('<custom>true</custom>');
    expect(xml).toContain('<userLicense>Salesforce</userLicense>');
  });

  it('should omit empty arrays', () => {
    const profile: Profile = {
      custom: true,
      classAccesses: [],
      applicationVisibilities: [],
    };

    const xml = buildProfileXml(profile);

    expect(xml).not.toContain('classAccesses');
    expect(xml).not.toContain('applicationVisibilities');
    expect(xml).toContain('<custom>true</custom>');
  });

  it('should serialize array sections', () => {
    const profile: Profile = {
      custom: true,
      classAccesses: [
        {apexClass: 'MyClass', enabled: true},
        {apexClass: 'OtherClass', enabled: false},
      ],
    };

    const xml = buildProfileXml(profile);

    expect(xml).toContain('<apexClass>MyClass</apexClass>');
    expect(xml).toContain('<enabled>true</enabled>');
    expect(xml).toContain('<apexClass>OtherClass</apexClass>');
    expect(xml).toContain('<enabled>false</enabled>');
  });

  it('should roundtrip a parsed profile', () => {
    const original = parseProfileXml(SAMPLE_PROFILE_XML);
    const xml = buildProfileXml(original);
    const reparsed = parseProfileXml(xml);

    // Structural equality (field values match)
    expect(reparsed.custom).toBe(original.custom);
    expect(reparsed.userLicense).toBe(original.userLicense);
    expect(reparsed.applicationVisibilities).toEqual(original.applicationVisibilities);
    expect(reparsed.classAccesses).toEqual(original.classAccesses);
    expect(reparsed.fieldPermissions).toEqual(original.fieldPermissions);
    expect(reparsed.userPermissions).toEqual(original.userPermissions);
    expect(reparsed.objectPermissions).toEqual(original.objectPermissions);
    expect(reparsed.tabVisibilities).toEqual(original.tabVisibilities);
    expect(reparsed.recordTypeVisibilities).toEqual(original.recordTypeVisibilities);
  });

  it('should omit undefined values', () => {
    const profile: Profile = {
      custom: true,
      description: undefined,
    };

    const xml = buildProfileXml(profile);

    expect(xml).not.toContain('description');
  });
});
