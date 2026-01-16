export interface VersionedPackage {
    packageName: string;
    packageId: string;
    path: string;

    currentVersion: string;
    newVersion: string | null;

    dependencies: VersionedPackage[];
}