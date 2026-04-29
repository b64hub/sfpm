import type {Logger} from '@b64/sfpm-core';

import {existsSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

import type {
  ComponentMap,
  OrgMetadataProvider,
  Profile,
  ProfileHooksOptions,
} from './types.js';

import {readProfileXml, writeProfileXml} from './profile-xml.js';
import {
  PROFILE_SECTION_NAME_FIELD,
} from './types.js';

/**
 * Handles cleaning and scoping of Salesforce profile XML files.
 *
 * Profile scoping removes permission entries from profile XML that
 * don't correspond to metadata present in the package being deployed.
 * This prevents deployment failures caused by references to components
 * that don't exist in the target org.
 *
 * Migrated from {@link https://github.com/flxbl-io/sfprofiles | sfprofiles}
 * and adapted to work as a standalone cleaner. By default scoping is
 * source-only: permissions referencing metadata absent from the package are
 * removed. When an {@link OrgMetadataProvider} is provided, the cleaner also
 * checks the target org — preserving permissions for standard metadata that
 * exists in the org but not in the package source.
 *
 * @example
 * ```typescript
 * const cleaner = new ProfileCleaner({ scope: 'source', removeLoginIpRanges: true });
 * const results = await cleaner.cleanProfiles('/path/to/profiles', knownComponents);
 * console.log(`Cleaned ${results.length} profile(s)`);
 *
 * // With org-aware scoping:
 * const orgResolver = new OrgMetadataResolver(connection, logger);
 * await cleaner.cleanProfiles('/path/to/profiles', knownComponents, orgResolver);
 * ```
 */
export class ProfileCleaner {
  readonly options: Required<ProfileHooksOptions>;

  constructor(
    options?: ProfileHooksOptions,
    private readonly logger?: Logger,
  ) {
    this.options = {
      removeLoginHours: options?.removeLoginHours ?? false,
      removeLoginIpRanges: options?.removeLoginIpRanges ?? false,
      removeUnassignedUserPermissions: options?.removeUnassignedUserPermissions ?? false,
      scope: options?.scope ?? 'source',
    };
  }

  /**
   * Clean a single parsed {@link Profile} object in-place.
   *
   * Applies:
   * 1. Section scoping (remove entries referencing absent metadata)
   * 2. Login hours stripping
   * 3. Login IP range stripping
   * 4. Unassigned user permission stripping
   *
   * @param profile - The profile to clean
   * @param packageComponents - Package components grouped by profile section
   * @param orgComponents - Pre-resolved org components grouped by profile section.
   *   When provided, these are merged with package components before scoping.
   *   Use {@link resolveOrgComponents} to pre-fetch from an {@link OrgMetadataProvider}.
   * @returns The cleaned profile (same reference, mutated)
   */
  async cleanProfile(
    profile: Profile,
    packageComponents?: ComponentMap,
    orgComponents?: ComponentMap,
  ): Promise<Profile> {
    if (this.options.scope !== 'none' && packageComponents && packageComponents.size > 0) {
      this.scopeSections(profile, packageComponents, orgComponents);
    }

    if (this.options.removeLoginHours) {
      delete profile.loginHours;
    }

    if (this.options.removeLoginIpRanges) {
      delete profile.loginIpRanges;
    }

    if (this.options.removeUnassignedUserPermissions) {
      this.removeUnassignedPermissions(profile);
    }

    return profile;
  }

  /**
   * Clean all profile files in the given directory.
   *
   * Reads every `.profile-meta.xml` file, applies scoping and
   * stripping rules, then writes the cleaned XML back to disk.
   *
   * @param profilesDirectory - Absolute path to the profiles directory
   * @param packageComponents - Package components grouped by profile section.
   *   When provided and `scope` is not `'none'`, profile sections referencing
   *   components not in the matching section set are removed.
   * @param orgResolver - Optional org metadata provider. When provided (and
   *   `scope` is `'org'`), components found in the target org are also
   *   preserved during scoping. Queried once upfront and shared across all profiles.
   * @returns Array of file paths that were cleaned
   */
  async cleanProfiles(
    profilesDirectory: string,
    packageComponents?: ComponentMap,
    orgResolver?: OrgMetadataProvider,
  ): Promise<string[]> {
    if (!existsSync(profilesDirectory)) {
      return [];
    }

    const files = await readdir(profilesDirectory);
    const profileFiles = files.filter(f => f.endsWith('.profile-meta.xml'));

    if (profileFiles.length === 0) {
      this.logger?.debug('No profile XML files found');
      return [];
    }

    this.logger?.debug(`Found ${profileFiles.length} profile(s) to clean`);

    // Resolve org components once upfront, shared across all profiles
    const orgComponents = orgResolver
      ? await this.resolveOrgComponents(orgResolver)
      : undefined;

    const results = await Promise.all(profileFiles.map(async file => {
      const filePath = join(profilesDirectory, file);
      try {
        const profile = await readProfileXml(filePath);
        const modified = await this.cleanProfile(profile, packageComponents, orgComponents);
        await writeProfileXml(filePath, modified);
        this.logger?.debug(`Cleaned profile: ${file}`);
        return filePath;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn(`Failed to clean profile ${file}: ${message}`);
        return null;
      }
    }));

    return results.filter((f): f is string => f !== null);
  }

  // ==========================================================================
  // Scoping — remove entries referencing absent metadata
  // ==========================================================================

  /**
   * Resolve org components for all profile sections in parallel.
   *
   * Call once and pass the result to {@link cleanProfile} to avoid
   * repeated org queries when cleaning multiple profiles.
   */
  async resolveOrgComponents(resolver: OrgMetadataProvider): Promise<ComponentMap> {
    const sections = Object.keys(PROFILE_SECTION_NAME_FIELD);
    const entries = await Promise.all(sections.map(async section => {
      const components = await resolver.getOrgComponents(section);
      return [section, components] as const;
    }));
    return new Map(entries);
  }

  /**
   * Filter items in a single profile section, keeping only those whose
   * referenced component exists in the known set for that section.
   */
  private filterSectionItems(
    section: string,
    items: Array<Record<string, unknown>>,
    nameField: string,
    knownComponents: ComponentMap,
  ): Array<Record<string, unknown>> {
    const sectionComponents = knownComponents.get(section) ?? new Set<string>();

    return items.filter(item => {
      const name = item[nameField] as string | undefined;
      if (!name) return true;

      if (section === 'fieldPermissions') {
        return this.isFieldKnown(name, sectionComponents, knownComponents.get('objectPermissions'));
      }

      if (section === 'layoutAssignments') {
        return this.isLayoutKnown(
          item as {layout?: string; recordType?: string},
          sectionComponents,
          knownComponents.get('recordTypeVisibilities'),
        );
      }

      return sectionComponents.has(name);
    });
  }

  /**
   * Check whether a field permission's component is known.
   *
   * A field is kept if the full qualified name (e.g. `Account.CustomField__c`)
   * exists in the field set, OR the parent object (e.g. `Account`) exists in
   * the object set.
   */
  private isFieldKnown(name: string, fieldComponents: Set<string>, objectComponents?: Set<string>): boolean {
    if (fieldComponents.has(name)) return true;
    const parent = name.split('.')[0];
    return objectComponents?.has(parent) ?? false;
  }

  /**
   * Check whether a layout assignment is known.
   *
   * The layout name must exist in the layout set. If a recordType is specified,
   * it must exist in either the layout set or the recordType set.
   */
  private isLayoutKnown(
    item: {layout?: string; recordType?: string},
    layoutComponents: Set<string>,
    recordTypeComponents?: Set<string>,
  ): boolean {
    if (!layoutComponents.has(item.layout ?? '')) return false;
    if (!item.recordType) return true;
    if (layoutComponents.has(item.recordType)) return true;
    return recordTypeComponents?.has(item.recordType) ?? false;
  }

  /**
   * Merge two component maps. For each section, the result is the union of
   * both maps' sets for that section.
   */
  private mergeComponentMaps(a: ComponentMap, b: ComponentMap): ComponentMap {
    const merged = new Map<string, Set<string>>();

    for (const [section, components] of a) {
      merged.set(section, new Set(components));
    }

    for (const [section, components] of b) {
      const existing = merged.get(section);
      if (existing) {
        for (const name of components) existing.add(name);
      } else {
        merged.set(section, new Set(components));
      }
    }

    return merged;
  }

  /**
   * Remove user permissions that have `enabled: false`.
   *
   * Standard profiles cannot have their userPermissions edited, so all
   * userPermissions are removed from non-custom profiles — mirroring the
   * sfprofiles behavior.
   */
  private removeUnassignedPermissions(profile: Profile): void {
    if (!profile.userPermissions || profile.userPermissions.length === 0) {
      return;
    }

    // Standard profiles: remove all user permissions (not editable)
    if (!profile.custom) {
      delete profile.userPermissions;
      return;
    }

    // Custom profiles: strip disabled permissions
    profile.userPermissions = profile.userPermissions.filter(p => p.enabled);
  }

  /**
   * For each profile section, filter out entries whose referenced component
   * name is not in the known component map for that section.
   *
   * When org components are provided, they are merged with package
   * components before filtering — preserving permissions for metadata that
   * is present in the org but not in the package source.
   */
  private scopeSections(
    profile: Profile,
    packageComponents: ComponentMap,
    orgComponents?: ComponentMap,
  ): void {
    const sections = Object.entries(PROFILE_SECTION_NAME_FIELD);

    // Merge package + org into a single map for uniform lookup
    const knownComponents = orgComponents
      ? this.mergeComponentMaps(packageComponents, orgComponents)
      : packageComponents;

    for (const [section, nameField] of sections) {
      const items = profile[section as keyof Profile] as Array<Record<string, unknown>> | undefined;
      if (!items || !Array.isArray(items)) {
        continue;
      }

      const before = items.length;
      const filtered = this.filterSectionItems(section, items, nameField, knownComponents);

      if (filtered.length !== before) {
        this.logger?.debug(`${section}: reduced from ${before} to ${filtered.length}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (profile as any)[section] = filtered;
    }
  }
}

/**
 * Find profile directories within a package's source path.
 *
 * Searches standard Salesforce directory structures for profile files.
 */
export function findProfilesDirectory(packagePath: string): string | undefined {
  const profilesDir = join(packagePath, 'profiles');
  if (existsSync(profilesDir)) {
    return profilesDir;
  }

  const defaultProfilesDir = join(packagePath, 'main', 'default', 'profiles');
  if (existsSync(defaultProfilesDir)) {
    return defaultProfilesDir;
  }

  return undefined;
}

/**
 * Collect metadata component names from a Salesforce source directory,
 * grouped by profile section.
 *
 * Walks standard metadata directories (classes, objects, pages, etc.)
 * and extracts component API names from file names. The results are
 * grouped by the profile section that references them, enabling
 * symmetric comparison with org metadata during profile scoping.
 *
 * @param packagePath - Root of the package source (e.g., `force-app/main/default`)
 * @returns Components grouped by profile section
 */
export async function collectPackageComponents(packagePath: string): Promise<ComponentMap> {
  const components: ComponentMap = new Map();

  /** Get or create the set for a section. */
  const forSection = (section: string): Set<string> => {
    let set = components.get(section);
    if (!set) {
      set = new Set();
      components.set(section, set);
    }

    return set;
  };

  // Mapping of directory names to the profile section they populate
  const directoryToSection: Array<{dir: string; section: string}> = [
    {dir: 'applications', section: 'applicationVisibilities'},
    {dir: 'classes', section: 'classAccesses'},
    {dir: 'customMetadata', section: 'customMetadataTypeAccesses'},
    {dir: 'customPermissions', section: 'customPermissions'},
    {dir: 'dataSources', section: 'externalDataSourceAccesses'},
    {dir: 'flows', section: 'flowAccesses'},
    {dir: 'layouts', section: 'layoutAssignments'},
    {dir: 'pages', section: 'pageAccesses'},
    {dir: 'tabs', section: 'tabVisibilities'},
  ];

  for (const {dir, section} of directoryToSection) {
    const dirPath = join(packagePath, dir);
    if (!existsSync(dirPath)) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      const files = await readdir(dirPath);
      const set = forSection(section);
      for (const file of files) {
        const name = stripSuffix(file);
        if (name) set.add(name);
      }
    } catch {
      // Skip directories we can't read
    }
  }

  // Objects directory populates multiple sections
  const objectsDir = join(packagePath, 'objects');
  if (existsSync(objectsDir)) {
    try {
      await collectObjectComponents(objectsDir, forSection);
    } catch {
      // Skip unreadable directory
    }
  }

  return components;
}

/**
 * Walk an `objects/` directory tree and collect components into their
 * respective profile sections:
 * - Object names → `objectPermissions`
 * - Field names → `fieldPermissions` (as `Object.Field`)
 * - Record type names → `recordTypeVisibilities` (as `Object.RecordType`)
 */
async function collectObjectComponents(
  objectsDir: string,
  forSection: (section: string) => Set<string>,
): Promise<void> {
  const objectDirs = await readdir(objectsDir);
  const objects = forSection('objectPermissions');
  const fields = forSection('fieldPermissions');
  const recordTypes = forSection('recordTypeVisibilities');

  for (const objDir of objectDirs) {
    const objPath = join(objectsDir, objDir);
    const objectName = objDir;
    objects.add(objectName);

    // Fields → fieldPermissions
    const fieldsDir = join(objPath, 'fields');
    if (existsSync(fieldsDir)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const fieldFiles = await readdir(fieldsDir);
        for (const f of fieldFiles) {
          const name = stripSuffix(f);
          if (name) fields.add(`${objectName}.${name}`);
        }
      } catch {/* skip */}
    }

    // Record types → recordTypeVisibilities
    const rtDir = join(objPath, 'recordTypes');
    if (existsSync(rtDir)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const rtFiles = await readdir(rtDir);
        for (const f of rtFiles) {
          const name = stripSuffix(f);
          if (name) recordTypes.add(`${objectName}.${name}`);
        }
      } catch {/* skip */}
    }
  }
}

/**
 * Remove all Salesforce metadata suffixes from a filename.
 * e.g., `Admin.profile-meta.xml` → `Admin`
 *       `MyClass.cls-meta.xml` → `MyClass`
 *       `Account.object-meta.xml` → `Account`
 */
function stripSuffix(fileName: string): string {
  // Handle `-meta.xml` suffix pattern
  return fileName.replace(/\.[^.]+(-meta)?\.xml$/, '');
}
