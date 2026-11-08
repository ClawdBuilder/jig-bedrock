// AWS Signature Version 4 for the one request shape this provider sends: a POST to Bedrock's Anthropic route with a JSON body
// and the credentials the AWS SDK resolves for the configured profile. Kept here, not in an SDK import, so it can be tested
// against AWS's published example and so nothing reaches for a credential store on its own.
import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

export interface SignInput {
    method: string;
    url: string;
    /** The request's headers as sent: `content-type`, `anthropic-version`, and so on. Auth headers are dropped here. */
    headers: Readonly<Record<string, string>>;
    body: string | Uint8Array;
    region: string;
    service?: string;
    credentials: AwsCredentials;
    now?: Date;
}

/** The `YYYYMMDDTHHMMSSZ` SigV4 date. */
export function amzDate(now: Date): string {
    return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986, which is what SigV4 canonicalizes with: encodeURIComponent leaves `!'()*` alone and this does not. */
function encode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(search: string): string {
    const pairs: Array<[string, string]> = [];
    for (const [name, value] of new URLSearchParams(search)) pairs.push([name, value]);
    return pairs
        .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
        .map(([name, value]) => `${encode(name)}=${encode(value)}`)
        .join("&");
}

/**
 * The headers that carry the signature: `authorization`, `x-amz-date`, and the session token when the credentials have one.
 * Every header given is signed, apart from the auth headers this replaces; `host` is taken from the URL.
 */
export function signRequest(input: SignInput): Record<string, string> {
    const url = new URL(input.url);
    const now = input.now ?? new Date();
    const timestamp = amzDate(now);
    const day = timestamp.slice(0, 8);
    const service = input.service ?? "bedrock";
    const payload = sha256(input.body);

    const headers = new Map<string, string>();
    for (const [name, value] of Object.entries(input.headers)) {
        const key = name.toLowerCase();
        if (key === "authorization" || key === "x-api-key" || key === "x-amz-date") continue;
        headers.set(key, value.trim().replace(/\s+/g, " "));
    }
    headers.set("host", url.host);
    headers.set("x-amz-date", timestamp);
    if (input.credentials.sessionToken) headers.set("x-amz-security-token", input.credentials.sessionToken);

    const names = [...headers.keys()].sort();
    const signedHeaders = names.join(";");
    const canonicalHeaders = names.map((name) => `${name}:${headers.get(name)}\n`).join("");
    const canonicalRequest = [
        input.method.toUpperCase(),
        url.pathname === "" ? "/" : url.pathname,
        canonicalQuery(url.search),
        canonicalHeaders,
        signedHeaders,
        payload,
    ].join("\n");
    const scope = `${day}/${input.region}/${service}/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
    const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, day);
    const kRegion = hmac(kDate, input.region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");

    return {
        authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "x-amz-date": timestamp,
        ...(input.credentials.sessionToken ? { "x-amz-security-token": input.credentials.sessionToken } : {}),
    };
}
