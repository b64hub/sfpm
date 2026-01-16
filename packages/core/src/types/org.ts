// Interface for Org interaction to decouple SFPOrg
export interface OrgPackageVersionFetcher {
    getInstalledVersion(packageName: string): Promise<string | null>;
}