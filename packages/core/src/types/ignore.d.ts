declare module 'ignore' {
    interface Ignore {
        add(pattern: string | string[]): Ignore;
        ignores(path: string): boolean;
        filter(paths: string[]): string[];
    }

    function ignore(): Ignore;
    export default ignore;
}
