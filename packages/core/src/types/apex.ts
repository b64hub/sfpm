import { FileDescriptor } from "./files.js";

export type ApexClasses = Array<string>;

export interface ApexSortedByType {
    class: FileDescriptor[];
    testClass: FileDescriptor[];
    interface: FileDescriptor[];
    parseError: FileDescriptor[];
};

