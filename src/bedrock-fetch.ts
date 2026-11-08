// A fetch for Pi's Anthropic Messages client that signs every request with the configured AWS profile's SSO credentials. The
// provider's route is Bedrock's Anthropic endpoint, which authenticates with SigV4 and not with an Anthropic key, so the client's
// own auth headers are removed before signing. Credentials stay in the credential chain's memory and are never written by this
// module.
import type { AwsCredentials } from "./sigv4.ts";
import { signRequest } from "./sigv4.ts";

/** The region in a Bedrock runtime host, or undefined when the URL is not one. */
export function regionOf(url: string): string | undefined {
    return /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(new URL(url).host)?.[1];
}

/** A body this signer can hash as one buffer: what the Anthropic SDK sends for a JSON request. */
function bodyOf(body: RequestInit["body"]): string | Uint8Array {
    if (body === undefined || body === null) return "";
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    throw new Error("Bedrock signing needs the whole request body, not a stream");
}

export interface SignedFetchOptions {
    /** Resolves the profile's credentials; the AWS SDK's default provider in production. */
    credentials: () => Promise<AwsCredentials>;
    /** The fetch requests go through, so a test can watch them. */
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    /** A credential failure that means the SSO session must be restored: the message has to reach Pi in one piece. */
    signInHint?: string;
}

const SSO_FAILURE = /aws sso login|sso session|token is expired|expired or is otherwise invalid/i;

/** `fetch` with the SigV4 headers of the profile's credentials, and without the client's own auth headers. */
export function createSignedFetch(options: SignedFetchOptions): typeof globalThis.fetch {
    const inner = options.fetch ?? globalThis.fetch;
    const now = options.now ?? (() => new Date());
    return async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method);
        const region = regionOf(url);
        if (region === undefined) throw new Error(`Not a Bedrock runtime URL: ${new URL(url).host}`);

        const headers = new Headers(init?.headers);
        // The Anthropic SDK always sends one of these because it is constructed with a key; neither may reach Bedrock.
        headers.delete("x-api-key");
        headers.delete("authorization");
        const given: Record<string, string> = {};
        headers.forEach((value, name) => {
            given[name] = value;
        });

        let credentials: AwsCredentials;
        try {
            credentials = await options.credentials();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (SSO_FAILURE.test(message)) {
                throw new Error(
                    `SSO session for the configured AWS profile is expired or invalid; run aws sso login with the configured profile. ${message}`,
                );
            }
            throw error;
        }
        const signed = signRequest({
            method,
            url,
            headers: given,
            body: bodyOf(init?.body),
            region,
            credentials,
            now: now(),
        });
        for (const [name, value] of Object.entries(signed)) headers.set(name, value);
        return inner(url, { ...init, headers });
    };
}
