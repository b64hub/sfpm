import { PackageInfo } from "../types/package.js";

export default class SfpmPackage implements PackageInfo {
    public projectDirectory: string;
    public workingDirectory: string = '';
    public mdapiDir: string;
    public destructiveChangesPath: string;
    public resolvedPackageDirectory: string;

    public version: string = '5';

    //Just a few helpers to resolve api differene
    public get packageName(): string {
        return this.package_name;
    }

    public get versionNumber(): string {
        return this.package_version_number;
    }

    public set versionNumber(versionNumber:string)
    {
        this.package_version_number = versionNumber;
    }

    public get packageType(): string {
        return this.package_type.toLocaleLowerCase();
    }

    public set packageType(packageType: string) {
        this.package_type = packageType;
        this.tag = packageType;
    }

    public constructor() {
    }

    toJSON(): PackageInfo {

        const data: PackageInfo = {
            package_name: this.package_name,
            package_version_number: this.package_version_number,
            package_type: this.packageType, // Uses your getter!
            tag: this.tag,
            // ... 
        };
        return data;


        // let castToPackageMetadata = _.cloneDeep(this);
        // delete castToPackageMetadata.workingDirectory;
        // delete castToPackageMetadata.mdapiDir;
        // delete castToPackageMetadata.projectConfig;
        // delete castToPackageMetadata.packageDescriptor;
        // delete castToPackageMetadata.projectDirectory;
        // delete castToPackageMetadata.resolvedPackageDirectory;
        // delete castToPackageMetadata.isTriggerAllTests;
        // return castToPackageMetadata;

    }
}
