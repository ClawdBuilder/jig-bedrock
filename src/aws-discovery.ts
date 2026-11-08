import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicCache } from "./cache.ts";
import { type Catalog, filterHash, type Profile, readCatalog, validArn } from "./catalog.ts";
import type { ResolvedConfig } from "./config.ts";

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON from the AWS CLI or usage program, checked field by field where it is used
type Json = any;
export type Status =
    | "ok"
    | "sso_expired"
    | "permission_denied"
    | "configuration"
    | "network"
    | "timeout"
    | "unavailable";
export interface CatalogSource {
    load(): Catalog | undefined;
    refresh(force?: boolean): Promise<Status>;
}
export type Runner = (
    program: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
) => Promise<string>;
export const runFile: Runner = (program, args, options) =>
    new Promise((resolve, reject) => {
        execFile(
            program,
            args,
            { ...options, encoding: "utf8", env: { ...process.env, AWS_CLI_AUTO_PROMPT: "off", AWS_PAGER: "" } },
            (error, stdout, stderr) =>
                error ? reject(new Error(error.killed ? "timeout" : stderr || error.message)) : resolve(stdout),
        );
    });
export function category(error: unknown): Status {
    const m = String(error).toLowerCase();
    return /access.?denied|not authorized to perform|unauthorizedoperation/.test(m)
        ? "permission_denied"
        : /could not be found|config profile|profile.*not found|missing.*(?:sso|region)|enoent/.test(m)
          ? "configuration"
          : /sso|token/.test(m) && /expired|invalid|login|unauthorized|does not exist/.test(m)
            ? "sso_expired"
            : /timeout|timed out/.test(m)
              ? "timeout"
              : /network|connect|dns|resolve|unreachable|proxy/.test(m)
                ? "network"
                : "unavailable";
}
export function discoveryHelp(status: Status): string {
    switch (status) {
        case "sso_expired":
            return "Run /aws-login, finish browser sign-in, then /bedrock-refresh.";
        case "permission_denied":
            return "Ask your AWS administrator to check catalog read permissions for the configured profile; then /bedrock-refresh.";
        case "configuration":
            return "Check AWS CLI v2 on PATH and the configured AWS profile and regions; then /bedrock-refresh.";
        case "network":
            return "Check network access to AWS, then /bedrock-refresh.";
        case "timeout":
            return "AWS discovery timed out; check network access, then /bedrock-refresh.";
        default:
            return "Check AWS access and the configuration in README.md, then /bedrock-refresh.";
    }
}
function entryMessage(error: unknown): string {
    const text = String(error);
    if (/profile scope/.test(text)) return text.replace(/^Error:\s*/, "");
    if (/model scope/.test(text)) return "model scope";
    if (category(error) === "permission_denied") return "denied";
    if (category(error) === "configuration") return "not found";
    return category(error);
}

export function createAwsDiscovery(
    config: ResolvedConfig,
    runner: Runner = runFile,
    file = join(homedir(), ".cache/jig-bedrock/catalog.json"),
    now = Date.now,
): CatalogSource {
    let flight: Promise<Status> | undefined,
        invalidAccount = false,
        last: Catalog | undefined;
    const mode =
        config.mode ??
        (config.profiles?.length ? "explicit" : config.team || config.tagValue || config.tagKey ? "tag" : "system");
    const activeKey = config.activeTagKey ?? (config.team !== undefined ? "Active" : undefined);
    const activeValue = config.activeTagValue ?? "true";
    const scope = { ...config, mode, team: config.team };
    const load = () => (invalidAccount ? undefined : (last ?? readCatalog(file, scope, now())));
    const perform = async (force = false): Promise<Status> => {
        let remaining = 8 * 1_048_576,
            pages = 0,
            deadline = now() + 90_000;
        const aws = async (args: string[]) => {
            const timeout = Math.min(20_000, deadline - now());
            if (timeout <= 0) throw new Error("timeout");
            const output = await runner(
                "aws",
                [...args, "--profile", config.profile, "--output", "json", "--no-cli-pager"],
                { timeout, maxBuffer: Math.min(remaining, 1_048_576) },
            );
            remaining -= Buffer.byteLength(output);
            if (remaining < 0 || Buffer.byteLength(output) > 1_048_576) throw new Error("byte limit");
            if (now() > deadline) throw new Error("timeout");
            return JSON.parse(output);
        };
        try {
            if (!force && !invalidAccount) {
                const cached = readCatalog(file, scope, now());
                if (cached && now() / 1000 - cached.fetched_at < 86_400) return "ok";
            }
            const account = (await aws(["sts", "get-caller-identity"])).Account;
            if (typeof account !== "string" || !/^\d{12}$/.test(account)) throw new Error("identity");
            const old = readCatalog(file, scope, now());
            if (old && old.account_id !== account) {
                invalidAccount = true;
                rmSync(file, { force: true });
            } else invalidAccount = false;
            const profiles: Profile[] = [],
                seen = new Set<string>(),
                explicitErrors: { profile: string; message: string }[] = [],
                warnings: string[] = [];
            const info = (arn: string, region: string) =>
                aws(["bedrock", "get-inference-profile", "--inference-profile-identifier", arn, "--region", region]);
            const foundation = async (value: Json, depth = 0): Promise<string> => {
                if (!Array.isArray(value.models) || !value.models.length || value.models.length > 32)
                    throw new Error("models");
                const ids = new Set<string>();
                for (const row of value.models) {
                    const match =
                        typeof row.modelArn === "string" &&
                        row.modelArn.match(/^arn:(aws|aws-cn|aws-us-gov):bedrock:([^:]+):([^:]*):(.+)$/);
                    if (!match) throw new Error("model ARN");
                    const resource = match[4];
                    if (resource.startsWith("foundation-model/")) {
                        const id = resource.slice(17);
                        // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in an AWS model id
                        if (!id || id.length > 256 || /[\x00-\x1f]/.test(id)) throw new Error("model ID");
                        ids.add(id);
                    } else if (resource.startsWith("inference-profile/") && depth < 2) {
                        if (match[3] && match[3] !== account && match[3] !== "aws") throw new Error("model scope");
                        ids.add(await foundation(await info(row.modelArn, match[2]), depth + 1));
                    }
                    else throw new Error("model scope");
                }
                if (ids.size !== 1) throw new Error("ambiguous model");
                return [...ids][0] as string;
            };
            const nameOf = (value: Json): string => {
                const name = value.inferenceProfileName;
                // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in an AWS profile name
                if (typeof name !== "string" || !name || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))
                    throw new Error("profile name");
                return name;
            };
            const add = async (candidate: string, region: string, kind: "application" | "system") => {
                if (!validArn(candidate, region, account, kind) || seen.has(candidate) || seen.size >= 256)
                    throw new Error("profile scope");
                const value = await info(candidate, region);
                if (value.inferenceProfileArn !== undefined && value.inferenceProfileArn !== candidate)
                    throw new Error("profile mismatch");
                if (value.status !== "ACTIVE") return;
                seen.add(candidate);
                profiles.push({
                    arn: candidate,
                    profile_name: nameOf(value),
                    foundation_model_id: await foundation(value),
                    region,
                    kind,
                });
            };
            if (mode === "explicit") {
                for (const entry of config.profiles ?? []) {
                    const match = entry.match(
                        /^arn:(aws|aws-cn|aws-us-gov):bedrock:([^:]+):([^:]*):(application-inference-profile|inference-profile)\/(.+)$/,
                    );
                    const kind = (match?.[4] === "inference-profile" ? "system" : "application") as
                        | "application"
                        | "system";
                    const region = match?.[2] ?? config.regions[0];
                    if (!region) throw new Error("profile scope");
                    try {
                        if (match && !config.regions.includes(region))
                            throw new Error(
                                `profile scope: ${entry} is in ${region}; add ${region} to bedrock.regions`,
                            );
                        if (match) await add(entry, region, kind);
                        else {
                            const found = await info(entry, region);
                            const foundArn = found.inferenceProfileArn;
                            if (typeof foundArn !== "string") throw new Error("profile ARN");
                            await add(foundArn, region, found.type === "SYSTEM_DEFINED" ? "system" : "application");
                        }
                    } catch (error) {
                        explicitErrors.push({ profile: entry, message: entryMessage(error) });
                    }
                }
            } else if (mode === "tag") {
                for (const region of config.regions) {
                    let token = "";
                    const tokens = new Set<string>();
                    for (let page = 0; page < 32; page++) {
                        if (++pages > 64) throw new Error("pagination");
                        const result = await aws([
                            "resourcegroupstaggingapi",
                            "get-resources",
                            "--region",
                            region,
                            "--resource-type-filters",
                            "bedrock:application-inference-profile",
                            "--tag-filters",
                            JSON.stringify([
                                { Key: config.tagKey ?? "Team", Values: [config.tagValue ?? config.team] },
                                ...(activeKey === undefined ? [] : [{ Key: activeKey, Values: [activeValue] }]),
                            ]),
                            "--no-paginate",
                            ...(token ? ["--pagination-token", token] : []),
                        ]);
                        if (!Array.isArray(result.ResourceTagMappingList) || result.ResourceTagMappingList.length > 256)
                            throw new Error("resources");
                        for (const row of result.ResourceTagMappingList) {
                            const arn = row.ResourceARN;
                            if (
                                typeof arn !== "string" ||
                                !validArn(arn, region, account) ||
                                seen.has(arn) ||
                                seen.size >= 256
                            )
                                throw new Error("profile scope");
                            const wanted = [
                                [config.tagKey ?? "Team", config.tagValue ?? config.team],
                                ...(activeKey === undefined ? [] : [[activeKey, activeValue]]),
                            ] as Array<[string, string | undefined]>;
                            if (
                                !Array.isArray(row.Tags) ||
                                !wanted.every(
                                    ([key, value]) =>
                                        row.Tags.filter((tag: Json) => tag?.Key === key).length === 1 &&
                                        row.Tags.some((tag: Json) => tag?.Key === key && tag.Value === value),
                                )
                            )
                                throw new Error("profile tags");
                            await add(arn, region, "application");
                        }
                        token = result.PaginationToken ?? "";
                        if (!token) break;
                        if (typeof token !== "string" || token.length > 2048 || tokens.has(token) || page === 31)
                            throw new Error("pagination");
                        tokens.add(token);
                    }
                }
            } else {
                for (const region of config.regions) {
                    let token = "";
                    const tokens = new Set<string>();
                    for (let page = 0; page < 32; page++) {
                        if (++pages > 64) throw new Error("pagination");
                        const result = await aws([
                            "bedrock",
                            "list-inference-profiles",
                            "--type-equals",
                            "SYSTEM_DEFINED",
                            "--region",
                            region,
                            ...(token ? ["--next-token", token] : []),
                        ]);
                        const rows = result.inferenceProfileSummaries;
                        if (!Array.isArray(rows) || rows.length > 256) throw new Error("profiles");
                        for (const row of rows) {
                            const arn = row?.inferenceProfileArn;
                            if (typeof arn !== "string") throw new Error("profile scope");
                            if (
                                !/(?:^|\/)(?:us|eu|apac|global)?\.?anthropic\.claude/i.test(
                                    `${arn} ${row.inferenceProfileName ?? ""}`,
                                )
                            )
                                continue;
                            await add(arn, region, "system");
                        }
                        token = result.nextToken ?? "";
                        if (!token) break;
                        if (typeof token !== "string" || token.length > 2048 || tokens.has(token) || page === 31)
                            throw new Error("pagination");
                        tokens.add(token);
                    }
                }
            }
            profiles.sort((a, b) => (a.arn < b.arn ? -1 : a.arn > b.arn ? 1 : 0));
            const failed = mode === "explicit" && profiles.length === 0 && explicitErrors.length > 0;
            if (mode === "tag" && profiles.length === 0) {
                const active =
                    activeKey === undefined ? "" : ` and ${activeKey}=${activeValue}`;
                warnings.push(
                    `No application inference profiles matched ${config.tagKey ?? "Team"}=${config.tagValue}${active} in ${config.regions.join(", ")}. Check bedrock.tagKey/tagValue.`,
                );
            }
            if (mode === "system" && profiles.length === 0)
                warnings.push(`No AWS-defined Claude inference profiles in ${config.regions.join(", ")}.`);
            const catalog: Catalog = {
                schema: 1,
                mode,
                team: config.team,
                aws_profile: config.profile,
                account_id: account,
                regions: config.regions,
                fetched_at: Math.floor(now() / 1000),
                filter_hash: filterHash(scope),
                ...(warnings.length > 0 ? { warnings } : {}),
                profiles,
                ...(explicitErrors.length > 0 ? { errors: explicitErrors } : {}),
            };
            atomicCache(file, catalog);
            last = catalog;
            invalidAccount = false;
            return failed ? "unavailable" : "ok";
        } catch (e) {
            return category(e);
        }
    };
    return {
        load,
        refresh: (force = false) =>
            (flight ??= perform(force).finally(() => {
                flight = undefined;
            })),
    };
}
