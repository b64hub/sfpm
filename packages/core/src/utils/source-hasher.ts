import crypto from 'crypto';
import fs from 'fs-extra';
import { SfpmMetadataPackage } from '../package/sfpm-package.js';

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
            if (component.xml) {
                const xmlContent = await fs.readFile(component.xml, 'utf-8');
                hash.update(xmlContent);
            }
            
            // Hash the actual source content if present (e.g., .cls, .trigger, .js files)
            if (component.content) {
                const sourceContent = await fs.readFile(component.content, 'utf-8');
                hash.update(sourceContent);
            }
        }
        
        return hash.digest('hex');
    }
}