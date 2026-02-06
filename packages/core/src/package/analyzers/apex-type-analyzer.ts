import { SfpmMetadataPackage } from "../sfpm-package.js";
import { PackageType, SfpmPackageContent } from "../../types/package.js";
import { ApexParser } from "../../apex/apex-parser.js";
import { PackageAnalyzer, RegisterAnalyzer } from "./analyzer-registry.js";
import path from 'path';

/**
 * To be implemented using Apex Language Server
 */
@RegisterAnalyzer()
export class ApexTypeAnalyzer implements PackageAnalyzer {

    public isEnabled(sfpmPackage: SfpmMetadataPackage): boolean {
        return sfpmPackage.type !== PackageType.Source && sfpmPackage.hasApex;
    }

    public async analyze(sfpmPackage: SfpmMetadataPackage): Promise<Partial<SfpmPackageContent>> {

        const components = sfpmPackage.apexClasses
            .filter(ac => ac.content !== undefined);

        const filePaths = components.map(ac => ac.content as string);

        const parser = new ApexParser();
        const classification = await parser.classifyBulk(filePaths);

        // Use SourceComponent.name for reliable names (parser returns "Unknown" on heuristic fallback)
        // Use relative path from staging directory for portable artifact paths
        const baseDir = sfpmPackage.stagingDirectory || sfpmPackage.projectDirectory;

        const enriched = classification.map((info, index) => ({
            ...info,
            name: components[index].name || info.name,
            path: path.relative(baseDir, components[index].content!),
        }));

        const classes = enriched
            .filter((info) => info.type === "Class" && !info.isTest)
            .map((info) => ({
                name: info.name,
                path: info.path,
            }));

        const triggers = enriched
            .filter((info) => info.type === "Trigger")
            .map((info) => ({
                name: info.name,
                path: info.path,
            }));

        const testClasses = enriched
            .filter((info) => info.type === "Class" && info.isTest)
            .map((info) => ({
                name: info.name,
                path: info.path,
            }));

        return {
            content: {
                apex: {
                    classes: classes,
                    tests: testClasses,
                },
                triggers: triggers,
            },
        };
    }
}