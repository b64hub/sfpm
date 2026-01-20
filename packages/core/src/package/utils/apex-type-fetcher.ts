import path from 'path';
import fs from 'fs-extra';

/**
 * @description Utility to fetch and classify Apex classes in a directory.
 */
export default class ApexTypeFetcher {
    constructor(private workingDirectory: string) { }

    /**
     * @description Classified classes by their type (test, classes, triggers).
     * This is a simplified version; real logic would parse files/metadata.
     */
    public getClassesClassifiedByType(): any {
        return {
            classes: [],
            triggers: [],
            testClasses: []
        };
    }
}
