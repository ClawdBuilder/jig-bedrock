// The AWS SDK's node credential chain, from this package's own dependency. It is loaded on first use, not at module load, so Pi's
// start-up does not pay for the SDK's many files until a request or a sign-in check needs a credential.

/** What the SDK's `defaultProvider` takes and gives: a function that resolves the profile's credentials when called. */
export type CredentialProvider = (init?: { profile?: string }) => () => Promise<unknown>;

/** `defaultProvider` of `@aws-sdk/credential-provider-node`, found in this package's `node_modules`. */
export async function loadCredentialProvider(): Promise<CredentialProvider> {
    const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
    return defaultProvider as CredentialProvider;
}
