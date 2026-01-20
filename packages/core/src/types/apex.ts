export type ApexClasses = Array<string>;

export type FileDescriptor = {
    name: string;
    filepath: string;
    error?: any;
};

export interface ApexSortedByType {
    class: FileDescriptor[];
    testClass: FileDescriptor[];
    interface: FileDescriptor[];
};

