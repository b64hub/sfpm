import fs from 'fs-extra';
import crypto from 'node:crypto';

import {SfpmMetadataPackage} from '../package/sfpm-package.js';

export class SourceHasher {
  public static async calculate(sfpmPackage: SfpmMetadataPackage): Promise<string> {
    const hash = crypto.createHash('sha256');

    // Get and sort components to ensure deterministic hash order
    const components = sfpmPackage.getComponentSet()
    .getSourceComponents()
    .toArray()
    .sort((a, b) => {
      // Sort by full name for deterministic ordering
      const aKey = `${a.type.name}:${a.fullName}`;
      const bKey = `${b.type.name}:${b.fullName}`;
      return aKey.localeCompare(bKey);
    });

    for (const component of components) {
      // Include component identity in hash for structural integrity
      hash.update(`${component.type.name}:${component.fullName}`);

      // Hash the metadata XML file if present
      // Skip directories (some edge cases might have xml as a folder reference)
      if (component.xml) {
        // eslint-disable-next-line no-await-in-loop -- we want to hash each file sequentially to manage memory usage
        const xmlStat = await fs.stat(component.xml).catch(() => null);
        if (xmlStat?.isFile()) {
          // eslint-disable-next-line no-await-in-loop -- we want to hash each file sequentially to manage memory usage
          const xmlContent = await fs.readFile(component.xml, 'utf8');
          hash.update(xmlContent);
        }
      }

      // Hash the actual source content if present (e.g., .cls, .trigger, .js files)
      // Skip directories (bundle types like LWC/Aura have content pointing to a folder)
      if (component.content) {
        // eslint-disable-next-line no-await-in-loop -- we want to hash each file sequentially to manage memory usage
        const stat = await fs.stat(component.content).catch(() => null);
        if (stat?.isFile()) {
          // eslint-disable-next-line no-await-in-loop -- we want to hash each file sequentially to manage memory usage
          const sourceContent = await fs.readFile(component.content, 'utf8');
          hash.update(sourceContent);
        }
      }
    }

    return hash.digest('hex');
  }
}
