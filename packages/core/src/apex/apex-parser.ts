import { ApexAstSerializer } from "./apex-ast-serializer.js";
import * as fs from "fs";
import * as path from "path";
import type * as jorje from "../types/jorje.js";

export type ApexClassInfo = {
    name: string;
    path: string;
    type: "Class" | "Interface" | "Trigger" | "Enum";
    isTest: boolean;
};

export class ApexParser {
    private serializer: ApexAstSerializer;

    constructor(serializer?: ApexAstSerializer) {
        this.serializer = serializer || new ApexAstSerializer();
    }

    public async classify(filePath: string): Promise<ApexClassInfo> {
        const sourceCode = await fs.readFile(filePath, { encoding: "utf-8" });
        const info = await this.getInfo(sourceCode);
        info.path = path.basename(filePath);
        return info;
    }

    private async getInfo(sourceCode: string): Promise<ApexClassInfo> {
        try {
            const ast = await this.serializer.serialize(sourceCode);
            return this.mapAstToInfo(ast);
        } catch {
            return this.runHeuristics(sourceCode);
        }
    }

    public async classifyBulk(filePaths: string[]): Promise<ApexClassInfo[]> {
        const sourceCodes = await Promise.all(filePaths.map(filePath => fs.readFile(filePath, { encoding: "utf-8" })));
        const infos = await this.getInfoBulk(sourceCodes);
        infos.forEach((info, index) => {
            info.path = path.basename(filePaths[index]);
        });
        return infos;
    }

    /**
     * Bulkified API for high-volume processing.
     */
    private async getInfoBulk(contents: string[]): Promise<ApexClassInfo[]> {
        return Promise.all(contents.map(c => this.getInfo(c)));
    }

    private mapAstToInfo(ast: jorje.ParserOutput): Partial<ApexClassInfo> {
        const unit = ast.unit;

        // Initialize defaults
        let type: ApexClassInfo["type"];
        let name: string;
        let isTest: boolean;

        // CompilationUnit is a discriminated union based on "@class"
        switch (unit["@class"]) {
            case "apex.jorje.data.ast.CompilationUnit$ClassDeclUnit": {
                // Narrow to ClassDeclUnit to access body
                const classUnit = unit as jorje.ClassDeclUnit;
                const body = classUnit.body;

                type = "Class";
                name = body.name.value; // Name is in the body's Identifier

                // Extract modifiers from body and check for @isTest annotation
                isTest = (body.modifiers || []).some(m =>
                    m["@class"] === "apex.jorje.data.ast.Modifier$Annotation" &&
                    (m as jorje.Annotation).name.value.toLowerCase() === "istest"
                );
                break;
            }

            case "apex.jorje.data.ast.CompilationUnit$InterfaceDeclUnit": {
                // Interfaces also have a body containing the name
                const interfaceUnit = unit as jorje.InterfaceDeclUnit;
                type = "Interface";
                name = interfaceUnit.body.name.value;
                break;
            }

            case "apex.jorje.data.ast.CompilationUnit$TriggerDeclUnit": {
                // Triggers have the name directly on the unit node
                const triggerUnit = unit as jorje.TriggerDeclUnit;
                type = "Trigger";
                name = triggerUnit.name.value;
                break;
            }

            case "apex.jorje.data.ast.CompilationUnit$EnumDeclUnit": {
                const enumUnit = unit as jorje.EnumDeclUnit;
                type = "Class"; // Or add 'Enum' to your type union if preferred
                name = enumUnit.body.name.value;
                break;
            }
        }

        return { name, type, isTest };
    }

    private runHeuristics(sourceCode: string): ApexClassInfo {
        return {
            type: sourceCode.includes(" interface ") ? "Interface" : "Class",
            isTest: sourceCode.toLowerCase().includes("@istest"),
        };
    }
}