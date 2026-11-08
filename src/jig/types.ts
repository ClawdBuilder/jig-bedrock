// The small part of Jig's runtime API this package uses. The package works without Jig; when Jig is present, `jig()` reads
// this through the process-wide slot in ./client.ts.
export interface JigApi {
    readonly config: {
        registerSection(
            name: string,
            validate: (value: unknown) => string[],
            options?: { union?: readonly string[]; replace?: readonly string[] },
        ): void;
        section(name: string): unknown;
    };
}
