import { describe, it, expect, vi } from "vitest";
import { ApexParser } from "../../src/apex/apex-parser.js";
import { ApexAstSerializer } from "../../src/apex/apex-ast-serializer.js";
import type * as jorje from "../../src/types/jorje.d.js";

describe("ApexParser Classification", () => {
    it("should detect a test class from raw AST", async () => {
        const serializer = new ApexAstSerializer();
        const parser = new ApexParser(serializer);

        /** * Full mock satisfying jorje.ParserOutput 
         *
         */
        const mockAst: jorje.ParserOutput = {
            "internalErrors": [],
            "parseErrors": [],
            "unit": {
                "@class": "apex.jorje.data.ast.CompilationUnit$ClassDeclUnit",
                "body": {
                    "@class": "apex.jorje.data.ast.ClassDecl",
                    "loc": {
                        "@class": "apex.jorje.data.IndexLocation",
                        "startIndex": 15,
                        "endIndex": 31,
                        "line": 2,
                        "column": 8
                    },
                    "modifiers": [
                        {
                            "@class": "apex.jorje.data.ast.Modifier$Annotation",
                            "loc": {
                                "@class": "apex.jorje.data.IndexLocation",
                                "startIndex": 0,
                                "endIndex": 7,
                                "line": 1,
                                "column": 1
                            },
                            "name": {
                                "@class": "apex.jorje.data.Identifiers$LocationIdentifier",
                                "loc": {
                                    "@class": "apex.jorje.data.IndexLocation",
                                    "startIndex": 1,
                                    "endIndex": 7,
                                    "line": 1,
                                    "column": 2
                                },
                                "value": "isTest"
                            },
                            "parameters": []
                        },
                        {
                            "@class": "apex.jorje.data.ast.Modifier$PublicModifier",
                            "loc": {
                                "@class": "apex.jorje.data.IndexLocation",
                                "startIndex": 8,
                                "endIndex": 14,
                                "line": 2,
                                "column": 1
                            }
                        }
                    ],
                    "name": {
                        "@class": "apex.jorje.data.Identifiers$LocationIdentifier",
                        "loc": {
                            "@class": "apex.jorje.data.IndexLocation",
                            "startIndex": 21,
                            "endIndex": 28,
                            "line": 2,
                            "column": 14
                        },
                        "value": "MyTestClass"
                    },
                    "typeArguments": {},
                    "members": [],
                    "superClass": {},
                    "interfaces": []
                }
            }
        } as unknown as jorje.ParserOutput;

        // Mocking the public serialize method which now returns the unwrapped output
        vi.spyOn(serializer, "serialize").mockResolvedValue(mockAst);

        const info = await parser.getInfo("public class MyTestClass {}");

        expect(info.isTest).toBe(true);
        expect(info.name).toBe("MyTestClass");
        expect(info.type).toBe("Class");
    });
});