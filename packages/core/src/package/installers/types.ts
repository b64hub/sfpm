import {ComponentSet} from '@salesforce/source-deploy-retrieve';

/**
 * A package that can be installed via subscriber version ID (04t) through
 * the Tooling API. Implemented by unlocked packages (when a built artifact
 * is available) and managed/subscriber packages.
 */
export interface VersionInstallable {
  installationKey?: string;
  packageVersionId: string;
}

/**
 * A package that can be installed via source deployment (Metadata API).
 * Implemented by source packages (always) and unlocked packages (when
 * installing from local source or as a fallback).
 */
export interface SourceDeployable {
  componentSet: ComponentSet;
  versionNumber?: string;
}

/**
 * A package that can be installed via data loading tools (e.g. SFDMU).
 *
 * Core is intentionally content-agnostic — it only exposes the directory
 * containing the data files. Concrete adapters (like @b64hub/sfpm-sfdmu)
 * interpret the directory contents (export.json, CSVs, etc.).
 */
export interface DataDeployable {
  /** Absolute path to the directory containing the data files */
  dataDirectory: string;
  versionNumber?: string;
}

/**
 * Lightweight reference to an external managed/subscriber package.
 *
 * Unlike the SfpmPackage hierarchy (which models local source packages used
 * in builds), ManagedPackageRef carries only the identity needed to install
 * a subscriber package version via the Tooling API. It deliberately does NOT
 * extend SfpmPackage — managed packages have no local source or build
 * lifecycle.
 */
export class ManagedPackageRef implements VersionInstallable {
  public readonly packageName: string;
  public readonly packageVersionId: string;
  public readonly versionNumber?: string;

  constructor(packageName: string, packageVersionId: string, versionNumber?: string) {
    this.packageName = packageName;
    this.packageVersionId = packageVersionId;
    this.versionNumber = versionNumber;
  }
}
