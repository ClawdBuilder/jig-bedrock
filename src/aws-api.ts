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

async function call(
    service: string,
    region: string,
    method: string,
    path: string,
    body: string,
    headers: Record<string, string>,
    options: AwsApiOptions,
): Promise<Response> {
    const url = `${host(service, region)}${path}`;
    const signed = signRequest({
        method,
        url,
        headers,
        body,
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
            body,
            signal: timeout(options),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/abort|timeout|timed out/i.test(message)) throw new Error("timeout");
        throw new Error(`network: ${message}`);
    }
    if (!response.ok) {
        let message = "";
        let type = "";
        try {
            const text = await response.text();
            const parsed = JSON.parse(text) as { message?: string; Message?: string; __type?: string; code?: string };
            message = parsed.message ?? parsed.Message ?? text;
            type = parsed.__type ?? parsed.code ?? "";
        } catch {
            message = response.statusText;
        }
        const prefix = type === "" ? `HTTP ${response.status}` : type.replace(/^.*#/, "");
        throw new Error(`${prefix}: ${message || `HTTP ${response.status}`}`);
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
): Promise<{ inferenceProfileSummaries: unknown[]; nextToken?: string }> {
    const query = new URLSearchParams({ typeEquals: "SYSTEM_DEFINED" });
    if (input.nextToken !== undefined) query.set("nextToken", input.nextToken);
    const response = await call("bedrock", region, "GET", `/inference-profiles?${query}`, "", {}, options);
    return (await response.json()) as never;
}

export async function getInferenceProfile(
    region: string,
    identifier: string,
    options: AwsApiOptions,
): Promise<Record<string, unknown>> {
    const response = await call(
        "bedrock",
        region,
        "GET",
        `/inference-profiles/${encodeURIComponent(identifier)}`,
        "",
        {},
        options,
    );
    return (await response.json()) as never;
}
