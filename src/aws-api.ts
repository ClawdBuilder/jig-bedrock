// Signed HTTPS calls for discovery. One credentials resolution per run, one request per operation, and the same JSON shapes
// the AWS CLI printed, so aws-discovery.ts can parse either path with one parser.
import { type AwsCredentials, signRequest } from "./sigv4.ts";

export interface AwsApiOptions {
    /** The credentials resolved once for this discovery run. */
    credentials: AwsCredentials;
    /** Injected in tests; global fetch in production. */
    fetch?: typeof globalThis.fetch;
    /** The CLI path's per-call timeout. */
    timeoutMs?: number;
    signal?: AbortSignal;
    now?: Date;
}

const timeout = (options: AwsApiOptions): AbortSignal => {
    const limit = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    return options.signal === undefined ? limit : AbortSignal.any([options.signal, limit]);
};

const host = (service: string, region: string): string =>
    service === "sts" ? `https://sts.${region}.amazonaws.com` : `https://${service}.${region}.amazonaws.com`;

/** An AWS HTTP error with the code and status AWS sent, so discovery can give advice for the real cause. */
export class AwsApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
        super(`${code === "" ? `HTTP ${status}` : code}: ${message || `HTTP ${status}`}`);
        this.name = "AwsApiError";
        this.code = code;
        this.status = status;
    }
}

const decodeXml = (text: string): string =>
    text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");

/**
 * The code and message of an AWS error. The Bedrock and tagging APIs answer JSON; STS answers XML. A body that is
 * neither is kept as the message, so a proxy's or a gateway's answer is not lost.
 */
function errorFields(text: string): { code: string; message: string } {
    const body = text.trim();
    if (body === "") return { code: "", message: "" };
    try {
        const parsed = JSON.parse(body) as Record<string, unknown> | null;
        if (typeof parsed === "object" && parsed !== null) {
            const type = parsed.__type ?? parsed.code;
            const message = parsed.message ?? parsed.Message;
            if (typeof type === "string" || typeof message === "string")
                return {
                    code: typeof type === "string" ? type.replace(/^.*#/, "").trim() : "",
                    message: typeof message === "string" ? message : "",
                };
        }
    } catch {}
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
    if (code !== undefined) {
        const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
        return { code: code.trim(), message: message === undefined ? "" : decodeXml(message) };
    }
    return { code: "", message: body.slice(0, 500) };
}

async function call(
    service: string,
    region: string,
    method: string,
    path: string,
    body: string | undefined,
    headers: Record<string, string>,
    options: AwsApiOptions,
): Promise<Response> {
    const url = `${host(service, region)}${path}`;
    const signed = signRequest({
        method,
        url,
        headers,
        body: body ?? "",
        region,
        service,
        credentials: options.credentials,
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    let response: Response;
    try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
            method,
            headers: { ...headers, ...signed },
            ...(body === undefined ? {} : { body }),
            signal: timeout(options),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/abort|timeout|timed out/i.test(message)) throw new Error("timeout");
        const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
        if (error instanceof TypeError && (cause !== undefined || /fetch failed/i.test(message)))
            throw new Error(`network: ${message}`);
        throw error;
    }
    if (!response.ok) {
        // Bedrock's REST errors name the type in a header and send only a message in the body; STS answers XML.
        const headerType = response.headers.get("x-amzn-ErrorType") ?? "";
        const fields = errorFields(await response.text());
        const headerCode = headerType.split(":")[0]?.trim() ?? "";
        throw new AwsApiError(
            headerCode === "" ? fields.code : headerCode,
            response.status,
            fields.message || response.statusText,
        );
    }
    return response;
}

export async function getCallerIdentity(region: string, options: AwsApiOptions): Promise<{ Account: string }> {
    const response = await call(
        "sts",
        region,
        "POST",
        "/",
        "Action=GetCallerIdentity&Version=2011-06-15",
        { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        options,
    );
    const text = await response.text();
    const account = /<Account>([^<]+)<\/Account>/.exec(text)?.[1];
    if (account === undefined) throw new Error("AWS returned an unexpected answer.");
    return { Account: account };
}

export interface GetResourcesInput {
    tagFilters: Array<{ Key: string; Values: string[] }>;
    paginationToken?: string;
}

export async function getResources(
    region: string,
    input: GetResourcesInput,
    options: AwsApiOptions,
): Promise<{
    ResourceTagMappingList: Array<{ ResourceARN: string; Tags: Array<{ Key: string; Value: string }> }>;
    PaginationToken?: string;
}> {
    const body = JSON.stringify({
        ResourceTypeFilters: ["bedrock:application-inference-profile"],
        TagFilters: input.tagFilters,
        ...(input.paginationToken === undefined ? {} : { PaginationToken: input.paginationToken }),
    });
    const response = await call(
        "tagging",
        region,
        "POST",
        "/",
        body,
        {
            "content-type": "application/x-amz-json-1.1",
            "x-amz-target": "ResourceGroupsTaggingAPI_20170126.GetResources",
        },
        options,
    );
    return (await response.json()) as never;
}

export interface ListInferenceProfilesInput {
    nextToken?: string;
}

export async function listInferenceProfiles(
    region: string,
    input: ListInferenceProfilesInput,
    options: AwsApiOptions,
): Promise<any> {
    const query = new URLSearchParams({ typeEquals: "SYSTEM_DEFINED" });
    if (input.nextToken !== undefined) query.set("nextToken", input.nextToken);
    const response = await call("bedrock", region, "GET", `/inference-profiles?${query}`, undefined, {}, options);
    return (await response.json()) as never;
}

export async function getInferenceProfile(region: string, identifier: string, options: AwsApiOptions): Promise<any> {
    const response = await call(
        "bedrock",
        region,
        "GET",
        `/inference-profiles/${encodeURIComponent(identifier)}`,
        undefined,
        {},
        options,
    );
    return (await response.json()) as never;
}
