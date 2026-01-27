import { SourceComponent } from "@salesforce/source-deploy-retrieve";
import { ApexParser } from "./apex-parser.js";

export default class ApexService {

    public static async categorizeApexClasses(components: SourceComponent[]): Promise<{classes: string[], tests: string[]}> {

        const apexClasses: { name: string, path?: string }[] = components.filter(component => component.type.id === 'apexclass').map(component => {
            return {
                name: component.name,
                path: component.content
            }
        });

        const parser = new ApexParser();
        const parsedClasses = await parser.classifyBulk(apexClasses.map(c => c.path || ""));

        return {
            classes: parsedClasses.filter(c => c.type === "Class" && !c.isTest).map(c => c.name),
            tests: parsedClasses.filter(c => c.type === "Class" && c.isTest).map(c => c.name)
        }
    }
}