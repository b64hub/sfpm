import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InstallerRegistry } from '../../../src/package/installers/installer-registry.js';
import { PackageType } from '../../../src/types/package.js';
import SfpmPackage from '../../../src/package/sfpm-package.js';

describe('InstallerRegistry', () => {
    beforeEach(() => {
        // Clear registry before each test
        (InstallerRegistry as any).installers = new Map();
    });

    describe('register', () => {
        it('should register an installer for a package type', () => {
            class MockInstaller {
                constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
                async connect(username: string): Promise<void> {}
                async exec(): Promise<void> {}
            }

            InstallerRegistry.register(PackageType.Unlocked, MockInstaller as any);

            const installer = InstallerRegistry.getInstaller(PackageType.Unlocked);
            expect(installer).toBe(MockInstaller);
        });

        it('should allow multiple installers for different types', () => {
            class UnlockedInstaller {
                constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
                async connect(username: string): Promise<void> {}
                async exec(): Promise<void> {}
            }

            class SourceInstaller {
                constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
                async connect(username: string): Promise<void> {}
                async exec(): Promise<void> {}
            }

            InstallerRegistry.register(PackageType.Unlocked, UnlockedInstaller as any);
            InstallerRegistry.register(PackageType.Source, SourceInstaller as any);

            expect(InstallerRegistry.getInstaller(PackageType.Unlocked)).toBe(UnlockedInstaller);
            expect(InstallerRegistry.getInstaller(PackageType.Source)).toBe(SourceInstaller);
        });

        it('should overwrite existing installer for same type', () => {
            class FirstInstaller {
                constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
                async connect(username: string): Promise<void> {}
                async exec(): Promise<void> {}
            }

            class SecondInstaller {
                constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
                async connect(username: string): Promise<void> {}
                async exec(): Promise<void> {}
            }

            InstallerRegistry.register(PackageType.Unlocked, FirstInstaller as any);
            InstallerRegistry.register(PackageType.Unlocked, SecondInstaller as any);

            expect(InstallerRegistry.getInstaller(PackageType.Unlocked)).toBe(SecondInstaller);
        });
    });

    describe('getInstaller', () => {
        it('should return undefined for unregistered type', () => {
            const installer = InstallerRegistry.getInstaller(PackageType.Unlocked);
            expect(installer).toBeUndefined();
        });

        it('should return registered installer', () => {
            class MockInstaller {
                constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
                async connect(username: string): Promise<void> {}
                async exec(): Promise<void> {}
            }

            InstallerRegistry.register(PackageType.Source, MockInstaller as any);

            const installer = InstallerRegistry.getInstaller(PackageType.Source);
            expect(installer).toBe(MockInstaller);
        });
    });

    describe('@RegisterInstaller decorator', () => {
        it('should register installer when decorator is applied', async () => {
            // Clear and get fresh reference
            (InstallerRegistry as any).installers = new Map();
            
            // Dynamically import to get fresh module
            const { RegisterInstaller } = await import('../../../src/package/installers/installer-registry.js');

            // Create a test installer class with the decorator
            class TestDecoratedInstaller {
                constructor(targetOrg: string, sfpmPackage: SfpmPackage) {}
                async connect(username: string): Promise<void> {}
                async exec(): Promise<void> {}
            }

            // Manually apply decorator to simulate what happens at class definition time
            RegisterInstaller(PackageType.Source)(TestDecoratedInstaller);

            const installer = InstallerRegistry.getInstaller(PackageType.Source);
            expect(installer).toBe(TestDecoratedInstaller);
        });
    });
});
