// A small in-memory AWS for provider tests: STS, Resource Groups Tagging and Bedrock over the same fetch the provider uses.
export interface FakeAwsProfile {
    arn: string;
    name: string;
    region: string;
    foundation: string;
    tags: Record<string, string>;
    kind?: "application" | "system";
}

export interface FakeAwsOptions {
    account?: string;
    profiles?: FakeAwsProfile[];
    /** Return an error for one operation. */
    fail?: (
        operation: "sts" | "tagging" | "list" | "get",
        region: string,
    ) => { status: number; body: string } | undefined;
    /** The case-mismatch fixture: the tag query returns nothing, the unfiltered listing returns 13 profiles. */
    caseMismatch?: boolean;
}

const account = "123456789012";
const profile = (name: string, tags: Record<string, string> = {}): FakeAwsProfile => ({
    arn: `arn:aws:bedrock:us-east-1:${account}:application-inference-profile/${name}`,
    name,
    region: "us-east-1",
    foundation: "anthropic.claude-sonnet-5-5",
    tags,
    kind: "application",
});

export function fakeAwsHttp(options: FakeAwsOptions = {}) {
    const accountId = options.account ?? account;
    const profiles = options.profiles ?? [
        profile("team-app", { Team: "fixture-team", Active: "true" }),
        {
            arn: `arn:aws:bedrock:us-east-1:${accountId}:inference-profile/global.anthropic.claude-sonnet-5-5`,
            name: "System Sonnet",
            region: "us-east-1",
            foundation: "anthropic.claude-sonnet-5-5",
            tags: {},
            kind: "system",
        },
    ];
    const calls: Array<{ url: string; body: string; target: string }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
        new Request(url, init);
        const text = String(url);
        const target = String((init?.headers as Record<string, string> | undefined)?.["x-amz-target"] ?? "");
        const body = String(init?.body ?? "");
        calls.push({ url: text, body, target });
        const region = /\.([a-z0-9-]+)\.amazonaws\.com/.exec(text)?.[1] ?? "us-east-1";
        const operation = text.includes("sts.")
            ? "sts"
            : target.includes("GetResources")
              ? "tagging"
              : text.includes("/inference-profiles/")
                ? "get"
                : "list";
        const failure = options.fail?.(operation, region);
        if (failure !== undefined)
            return new Response(failure.body, {
                status: failure.status,
                headers: { "content-type": "application/json" },
            });
        if (operation === "sts")
            return new Response(
                `<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${accountId}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`,
            );
        if (operation === "tagging") {
            const parsed =
                body === "" ? {} : (JSON.parse(body) as { TagFilters?: Array<{ Key: string; Values: string[] }> });
            const filters = parsed.TagFilters ?? [];
            const source = options.caseMismatch
                ? Array.from({ length: 13 }, (_, index) =>
                      profile(`p${index + 1}`, { Team: "fixture-team", Active: "true" }),
                  )
                : profiles.filter((entry) => entry.kind !== "system" && entry.region === region);
            const rows = source.filter((entry) =>
                filters.every(
                    (filter) => entry.tags[filter.Key] !== undefined && filter.Values.includes(entry.tags[filter.Key]!),
                ),
            );
            return Response.json({
                ResourceTagMappingList: rows.map((entry) => ({
                    ResourceARN: entry.arn,
                    Tags: Object.entries(entry.tags).map(([Key, Value]) => ({ Key, Value })),
                })),
            });
        }
        if (operation === "list")
            return Response.json({
                inferenceProfileSummaries: profiles
                    .filter((entry) => entry.kind === "system" && entry.region === region)
                    .map((entry) => ({
                        inferenceProfileArn: entry.arn,
                        inferenceProfileName: entry.name,
                        status: "ACTIVE",
                        models: [{ modelArn: `arn:aws:bedrock:${entry.region}::foundation-model/${entry.foundation}` }],
                    })),
            });
        const identifier = decodeURIComponent(text.split("/inference-profiles/")[1] ?? "").split("?")[0]!;
        const entry = profiles.find((value) => value.arn === identifier || value.arn.endsWith(`/${identifier}`));
        if (entry === undefined) return new Response("{}", { status: 404 });
        return Response.json({
            inferenceProfileArn: entry.arn,
            inferenceProfileName: entry.name,
            status: "ACTIVE",
            models: [{ modelArn: `arn:aws:bedrock:${entry.region}::foundation-model/${entry.foundation}` }],
        });
    };
    return { fetch: fetch as typeof globalThis.fetch, calls };
}
