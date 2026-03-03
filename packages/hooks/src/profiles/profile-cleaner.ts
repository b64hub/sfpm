import type {Logger} from '@b64/sfpm-core';

import {existsSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

import type {
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
   * @param packageMetadata - Known component names in the package
   * @param orgResolver - Optional org metadata provider for org-aware scoping
   * @returns The cleaned profile (same reference, mutated)
   */
  async cleanProfile(
    profile: Profile,
    packageMetadata?: Set<string>,
    orgResolver?: OrgMetadataProvider,
  ): Promise<Profile> {
    if (this.options.scope !== 'none' && packageMetadata && packageMetadata.size > 0) {
      await this.scopeSections(profile, packageMetadata, orgResolver);
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
   * @param packageMetadata - Set of fully-qualified metadata component names
   *   present in the package (e.g., `"Account"`, `"MyApp__c"`, `"Account.MyField__c"`).
   *   When provided and `scope` is not `'none'`, profile sections referencing
   *   components not in this set are removed.
   * @param orgResolver - Optional org metadata provider. When provided (and
   *   `scope` is `'org'`), components found in the target org are also
   *   preserved during scoping.
   * @returns Array of file paths that were cleaned
   */
  async cleanProfiles(
    profilesDirectory: string,
    packageMetadata?: Set<string>,
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

    const results = await Promise.all(profileFiles.map(async file => {
      const filePath = join(profilesDirectory, file);
      try {
        const profile = await readProfileXml(filePath);
        const modified = await this.cleanProfile(profile, packageMetadata, orgResolver);
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
   * Filter items in a single profile section, keeping only those whose
   * referenced component exists in the known set.
   */
  private filterSectionItems(
    section: string,
    items: Array<Record<string, unknown>>,
    nameField: string,
    context: {knownComponents: Set<string>; orgComponentsMap: Map<string, Set<string>>},
  ): Array<Record<string, unknown>> {
    return items.filter(item => {
      const name = item[nameField] as string | undefined;
      if (!name) return true;

      if (section === 'fieldPermissions') {
        return this.isFieldKnown(name, context.knownComponents);
      }

      if (section === 'layoutAssignments') {
        return this.isLayoutKnown(
          item as {layout?: string; recordType?: string},
          context.knownComponents,
          context.orgComponentsMap,
        );
      }

      return context.knownComponents.has(name);
    });
  }

  /**
   * Check whether a field permission's component is known (by full name or parent object).
   */
  private isFieldKnown(name: string, knownComponents: Set<string>): boolean {
    const parent = name.split('.')[0];
    return knownComponents.has(name) || knownComponents.has(parent);
  }

  /**
   * Check whether a layout assignment is known (layout + optional recordType).
   */
  private isLayoutKnown(
    item: {layout?: string; recordType?: string},
    knownComponents: Set<string>,
    orgComponentsMap: Map<string, Set<string>>,
  ): boolean {
    if (!knownComponents.has(item.layout ?? '')) return false;
    if (!item.recordType) return true;
    if (knownComponents.has(item.recordType)) return true;

    const orgRecordTypes = orgComponentsMap.get('recordTypeVisibilities');
    return orgRecordTypes?.has(item.recordType) ?? false;
  }

  /**
   * Merge source metadata with org components for a given section.
   */
  private mergeWithOrgComponents(
    metadata: Set<string>,
    orgComponents?: Set<string>,
  ): Set<string> {
    if (!orgComponents || orgComponents.size === 0) return metadata;
    return new Set([...metadata, ...orgComponents]);
  }

  /**
   * Pre-fetch org components for all sections in parallel.
   */
  private async prefetchOrgComponents(
    resolver: OrgMetadataProvider,
    sections: string[],
  ): Promise<Map<string, Set<string>>> {
    const entries = await Promise.all(sections.map(async section => {
      const components = await resolver.getOrgComponents(section);
      return [section, components] as const;
    }));
    return new Map(entries);
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
   * name is not in the known metadata set.
   *
   * This is the core logic migrated from sfprofiles' `ProfileComponentReconciler`.
   * When an org resolver is provided and `scope` is `'org'`, components found in
   * the org are merged with the source metadata set before filtering — preserving
   * permissions for standard metadata that is present in the org but not in the
   * package.
   */
  private async scopeSections(
    profile: Profile,
    metadata: Set<string>,
    orgResolver?: OrgMetadataProvider,
  ): Promise<void> {
    const sections = Object.entries(PROFILE_SECTION_NAME_FIELD);

    // Pre-fetch all org components in parallel to avoid await-in-loop
    const orgComponentsMap = orgResolver
      ? await this.prefetchOrgComponents(orgResolver, sections.map(([s]) => s))
      : new Map<string, Set<string>>();

    for (const [section, nameField] of sections) {
      const items = profile[section as keyof Profile] as Array<Record<string, unknown>> | undefined;
      if (!items || !Array.isArray(items)) {
        continue;
      }

      const knownComponents = this.mergeWithOrgComponents(metadata, orgComponentsMap.get(section));
      const before = items.length;
      const filtered = this.filterSectionItems(section, items, nameField, {knownComponents, orgComponentsMap});

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
 * Collect metadata component names from a Salesforce source directory.
 *
 * Walks standard metadata directories (classes, objects, pages, etc.)
 * and extracts component API names from file names. This builds the set
 * against which profile sections are scoped.
 *
 * @param packagePath - Root of the package source (e.g., `force-app/main/default`)
 * @returns Set of fully-qualified component names
 */
export async function collectPackageMetadata(packagePath: string): Promise<Set<string>> {
  const metadata = new Set<string>();

  // Mapping of directory names to how we extract component names
  const directoryMappings: Array<{
    dir: string;
    extractor: (fileName: string, parentDir?: string) => string[];
  }> = [
    {dir: 'applications', extractor: f => [stripSuffix(f)]},
    {dir: 'classes', extractor: f => [stripSuffix(f)]},
    {dir: 'customMetadata', extractor: f => [stripSuffix(f)]},
    {dir: 'customPermissions', extractor: f => [stripSuffix(f)]},
    {dir: 'dataSources', extractor: f => [stripSuffix(f)]},
    {dir: 'flows', extractor: f => [stripSuffix(f)]},
    {dir: 'layouts', extractor: f => [stripSuffix(f)]},
    {dir: 'pages', extractor: f => [stripSuffix(f)]},
    {dir: 'tabs', extractor: f => [stripSuffix(f)]},
    {dir: 'objects', extractor: objectExtractor},
  ];

  for (const {dir, extractor} of directoryMappings) {
    const dirPath = join(packagePath, dir);
    if (!existsSync(dirPath)) continue;

    try {
      if (dir === 'objects') {
        // eslint-disable-next-line no-await-in-loop
        await collectObjectMetadata(dirPath, metadata);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const files = await readdir(dirPath);
        addFileMetadata(files, extractor, metadata);
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return metadata;
}

/**
 * Walk an `objects/` directory tree and collect object names, field names,
 * record type names, etc.
 */
async function collectObjectMetadata(objectsDir: string, metadata: Set<string>): Promise<void> {
  const objectDirs = await readdir(objectsDir);

  for (const objDir of objectDirs) {
    const objPath = join(objectsDir, objDir);

    // The directory name is the object API name
    const objectName = objDir;
    metadata.add(objectName);

    // Collect child components (fields, recordTypes, etc.)
    const childDirs: Array<{prefix: boolean; subdir: string;}> = [
      {prefix: true, subdir: 'fields'},
      {prefix: true, subdir: 'recordTypes'},
      {prefix: true, subdir: 'listViews'},
      {prefix: true, subdir: 'validationRules'},
      {prefix: true, subdir: 'webLinks'},
      {prefix: true, subdir: 'compactLayouts'},
      {prefix: true, subdir: 'businessProcesses'},
    ];

    for (const {prefix, subdir} of childDirs) {
      const childPath = join(objPath, subdir);
      if (!existsSync(childPath)) continue;

      try {
        // eslint-disable-next-line no-await-in-loop
        const files = await readdir(childPath);
        addChildMetadata(files, objectName, prefix, metadata);
      } catch {
        // Skip unreadable directories
      }
    }
  }
}

/**
 * Add metadata names from file names using the given extractor.
 */
function addFileMetadata(
  files: string[],
  extractor: (fileName: string, parentDir?: string) => string[],
  metadata: Set<string>,
): void {
  for (const file of files) {
    for (const name of extractor(file)) {
      if (name) metadata.add(name);
    }
  }
}

/**
 * Add child component metadata (fields, recordTypes, etc.) from file names.
 */
function addChildMetadata(
  files: string[],
  objectName: string,
  prefix: boolean,
  metadata: Set<string>,
): void {
  for (const file of files) {
    const name = stripSuffix(file);
    if (name) {
      metadata.add(prefix ? `${objectName}.${name}` : name);
    }
  }
}

/**
 * Extract component names from files in an objects directory.
 * For top-level object files, returns the object name.
 */
function objectExtractor(fileName: string): string[] {
  return [stripSuffix(fileName)];
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
