import SfpmPackage from "../sfpm-package.js";
import { PackageType, SfpmPackageContent } from "../../types/package.js";
import { ApexParser } from "../../apex/apex-parser.js";
import { PackageAnalyzer } from "./analyzer-registry.js";

/**
 * To be implemented using Apex Language Server
 */
@RegisterAnalyzer()
export class ApexTypeAnalyzer implements PackageAnalyzer {

    public isEnabled(sfpmPackage: SfpmPackage): boolean {
        return sfpmPackage.type !== PackageType.Source && sfpmPackage.hasApex;
    }

    public async analyze(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageContent>> {

        const files = sfpmPackage.apexClasses;

        const parser = new ApexParser();
        const classification = await parser.classifyBulk(files);

        const classes = classification.map((info) => {
            if (info.type === "Class" && !info.isTest) {
                return {
                    name: info.name,
                    path: info.path,
                };
            }
        }) || [];

        const triggers = classification.map((info) => {
            if (info.type === "Trigger") {
                return {
                    name: info.name,
                    path: info.path,
                };
            }
        }) || [];

        const testClasses = classification.map((info) => {
            if (info.type === "Class" && info.isTest) {
                return {
                    name: info.name,
                    path: info.path,
                };
            }
        }) || [];

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