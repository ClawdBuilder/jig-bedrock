// Test-only adapter: a fake aws-api backed by the same fake `aws` CLI fixtures the old runner tests used. Discovery itself
// only sees typed aws-api functions; this file exists so those fixtures keep their exact behaviour and call counts.
import { type CatalogSource, createAwsDiscovery } from "../../src/aws-discovery.ts";
import type { AwsCredentials } from "../../src/sigv4.ts";

type Runner = (program: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<string>;
const call = async (runner: Runner, args: string[], options: { timeoutMs?: number }, region: string) => {
    const text = await runner("aws", [...args, "--region", region, "--output", "json", "--no-cli-pager"], {
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: 1_048_576,
    });
    if (Buffer.byteLength(text) > 1_048_576) throw new Error("byte limit");
    return JSON.parse(text);
};
export function apiFromRunner(runner: Runner) {
    return {
        getCallerIdentity: async (region: string, options: { timeoutMs?: number }) => {
            const value = await call(runner, ["sts", "get-caller-identity"], options, region);
            return { Account: String(value.Account) };
        },
        getResources: async (
            region: string,
            input: { tagFilters: Array<{ Key: string; Values: string[] }>; paginationToken?: string },
            options: { timeoutMs?: number },
        ) =>
            call(
                runner,
                [
                    "resourcegroupstaggingapi",
                    "get-resources",
                    "--resource-type-filters",
                    "bedrock:application-inference-profile",
                    "--tag-filters",
                    JSON.stringify(input.tagFilters),
                    "--no-paginate",
                    ...(input.paginationToken === undefined ? [] : ["--pagination-token", input.paginationToken]),
                ],
                options,
                region,
            ),
        listInferenceProfiles: async (region: string, input: { nextToken?: string }, options: { timeoutMs?: number }) =>
            call(
                runner,
                [
                    "bedrock",
                    "list-inference-profiles",
                    "--type-equals",
                    "SYSTEM_DEFINED",
                    ...(input.nextToken === undefined ? [] : ["--next-token", input.nextToken]),
                ],
                options,
                region,
            ),
        getInferenceProfile: async (region: string, id: string, options: { timeoutMs?: number }) =>
            call(runner, ["bedrock", "get-inference-profile", "--inference-profile-identifier", id], options, region),
    };
}
export function createTestDiscovery(
    config: Parameters<typeof createAwsDiscovery>[0],
    runner: Runner,
    file?: string | (() => string),
    now = Date.now,
    env: NodeJS.ProcessEnv = process.env,
    extra: { fetch?: typeof globalThis.fetch; credentials?: () => Promise<AwsCredentials>; useApi?: boolean } = {},
): CatalogSource {
    return createAwsDiscovery(config, file, now, env, {
        api: apiFromRunner(runner) as never,
        useApi: extra.useApi ?? true,
        ...(extra.fetch === undefined ? {} : { fetch: extra.fetch }),
        credentials: extra.credentials ?? (async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" })),
    });
}
