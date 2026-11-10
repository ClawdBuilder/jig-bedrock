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
    /** Why the last refresh failed, in plain words; undefined after a success. */
    failure?(): string | undefined;
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
class StepError extends Error {
    readonly step: string;
    readonly cause: unknown;
    constructor(step: string, cause: unknown) {
        super(step);
        this.step = step;
        this.cause = cause;
    }
}

/** A short, plain reason for one profile that could not be read. Never includes an account id. */
export function profileFailureMessage(error: unknown): string {
    const text = String(error);
    if (/model ARN/.test(text)) return "its model address has an unexpected form";
    if (/model ID/.test(text)) return "its model id is empty or invalid";
    if (/ambiguous model/.test(text)) return "its models point at more than one foundation model";
    if (/model scope/.test(text)) return "one of its models is outside this account or region";
    if (/profile mismatch/.test(text)) return "AWS returned a different profile";
    if (/profile name/.test(text)) return "its name is empty or invalid";
    if (/profile tags/.test(text)) return "its tags do not match the configured team";
    if (/profile ARN/.test(text)) return "AWS returned no profile address";
    if (/profile scope/.test(text)) return "its address is outside the configured account, region or kind";
    const status = category(error);
    if (status === "permission_denied") return "AWS denied access";
    if (status === "configuration") return "its AWS configuration is missing or wrong";
    if (status === "network") return "AWS could not be reached";
    if (status === "timeout") return "AWS timed out";
    return "AWS returned an unexpected answer";
}

/** At most three short profile ids and a pointer to the full list; the notice stays one line. */
export function problemSummary(errors: Array<{ profile: string; message: string }>, limit = 3): string | undefined {
    if (errors.length === 0) return undefined;
    const short = (profile: string) => profile.slice(profile.lastIndexOf("/") + 1) || profile;
    const shown = errors.slice(0, limit).map((entry) => `${short(entry.profile)}: ${entry.message}`);
    const rest = errors.length > limit ? `; and ${errors.length - limit} more: /bedrock-profiles lists them` : "";
    return `Could not read ${shown.join("; ")}${rest}.`;
}

function reasonOf(error: unknown): string {
    const status = category(error);
    if (status === "permission_denied") return "AWS denied access";
    if (status === "configuration") return "the AWS configuration is missing or wrong";
    if (status === "network") return "AWS could not be reached";
    if (status === "timeout") return "AWS timed out";
    return "AWS returned an unexpected answer";
}

function failureText(error: unknown): string {
    if (error instanceof StepError) return `Could not ${error.step}: ${reasonOf(error.cause)}.`;
    return `Could not load the Bedrock profiles: ${reasonOf(error)}.`;
}

async function eachLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            await worker(items[index] as T);
        }
    });
    await Promise.all(workers);
}

export function createAwsDiscovery(
    config: ResolvedConfig,
    runner: Runner = runFile,
    file = join(homedir(), ".cache/jig-bedrock/catalog.json"),
    now = Date.now,
): CatalogSource {
    let flight: Promise<Status> | undefined,
        invalidAccount = false,
        lastFailure: string | undefined;
    // Rebuilt per call: the profile is resolved once a session starts, after this object exists, and Jig's section
    // can arrive even later (#14's late settings). A captured mode or tag key would make the cache scope stale.
    const modeFor = (): "explicit" | "tag" | "system" =>
        config.mode ??
        (config.profiles?.length ? "explicit" : config.team || config.tagValue || config.tagKey ? "tag" : "system");
    const activeKeyFor = (): string | undefined =>
        config.activeTagKey ?? (config.team !== undefined ? "Active" : undefined);
    const scope = () => ({ ...config, mode: modeFor(), team: config.team });
    const load = () => (invalidAccount ? undefined : readCatalog(file, scope(), now()));
    const perform = async (force = false): Promise<Status> => {
        const mode = modeFor();
        const activeKey = activeKeyFor();
        const activeValue = config.activeTagValue ?? "true";
        let remaining = 8 * 1_048_576,
            pages = 0,
            deadline = now() + 90_000;
        const aws = async (args: string[]) => {
            const timeout = Math.min(20_000, deadline - now());
            if (timeout <= 0) throw new Error("timeout");
            const output = await runner(
                "aws",
                [
                    ...args,
                    ...(config.profile ? ["--profile", config.profile] : []),
                    "--output",
                    "json",
                    "--no-cli-pager",
                ],
                { timeout, maxBuffer: Math.min(remaining, 1_048_576) },
            );
            remaining -= Buffer.byteLength(output);
            if (remaining < 0 || Buffer.byteLength(output) > 1_048_576) throw new Error("byte limit");
            if (now() > deadline) throw new Error("timeout");
            return JSON.parse(output);
        };
        const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
            try {
                return await run();
            } catch (error) {
                throw new StepError(name, error);
            }
        };
        try {
            if (!force && !invalidAccount) {
                const cached = readCatalog(file, scope(), now());
                if (cached && now() / 1000 - cached.fetched_at < 86_400) return "ok";
            }
            const account = (await step("check the AWS account", () => aws(["sts", "get-caller-identity"]))).Account;
            if (typeof account !== "string" || !/^\d{12}$/.test(account)) throw new Error("identity");
            const old = readCatalog(file, scope(), now());
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
                        row.modelArn.match(/^arn:(aws|aws-cn|aws-us-gov):bedrock:([^:]*):([^:]*):(.+)$/);
                    if (!match) throw new Error("model ARN");
                    const resource = match[4];
                    if (resource.startsWith("foundation-model/")) {
                        const id = resource.slice(17);
                        // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in an AWS model id
                        if (!id || id.length > 256 || /[\x00-\x1f]/.test(id)) throw new Error("model ID");
                        ids.add(id);
                    } else if (resource.startsWith("inference-profile/") && depth < 2) {
                        if (!match[2] || (match[3] && match[3] !== account && match[3] !== "aws"))
                            throw new Error("model scope");
                        ids.add(await foundation(await info(row.modelArn, match[2]), depth + 1));
                    } else throw new Error("model scope");
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
                const foundationModelId = await foundation(value);
                if (kind === "system" && !foundationModelId.startsWith("anthropic.claude")) return;
                profiles.push({
                    arn: candidate,
                    profile_name: nameOf(value),
                    foundation_model_id: foundationModelId,
                    region,
                    kind,
                });
            };
            const candidates: Array<{
                profile: string;
                region: string;
                kind: "application" | "system";
                arn?: string;
            }> = [];
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
                    if (match && !config.regions.includes(region)) {
                        explicitErrors.push({
                            profile: entry,
                            message: `it is in ${region}; add ${region} to bedrock.regions`,
                        });
                        continue;
                    }
                    candidates.push({ profile: entry, region, kind, ...(match ? { arn: entry } : {}) });
                }
            } else if (mode === "tag") {
                for (const region of config.regions) {
                    let token = "";
                    const tokens = new Set<string>();
                    for (let page = 0; page < 32; page++) {
                        if (++pages > 64) throw new Error("pagination");
                        const result = await step("list tagged inference profiles", () =>
                            aws([
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
                            ]),
                        );
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
                            candidates.push({ profile: arn, region, kind: "application", arn });
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
                        const result = await step("list inference profiles", () =>
                            aws([
                                "bedrock",
                                "list-inference-profiles",
                                "--type-equals",
                                "SYSTEM_DEFINED",
                                "--region",
                                region,
                                ...(token ? ["--next-token", token] : []),
                            ]),
                        );
                        const rows = result.inferenceProfileSummaries;
                        if (!Array.isArray(rows) || rows.length > 256) throw new Error("profiles");
                        for (const row of rows) {
                            const arn = row?.inferenceProfileArn;
                            if (typeof arn !== "string") throw new Error("profile scope");
                            if (!/anthropic\.claude/i.test(`${arn} ${row.inferenceProfileName ?? ""}`)) continue;
                            candidates.push({ profile: arn, region, kind: "system", arn });
                        }
                        token = result.nextToken ?? "";
                        if (!token) break;
                        if (typeof token !== "string" || token.length > 2048 || tokens.has(token) || page === 31)
                            throw new Error("pagination");
                        tokens.add(token);
                    }
                }
            }
            await eachLimit(candidates, 4, async (candidate) => {
                try {
                    if (candidate.arn) {
                        await add(candidate.arn, candidate.region, candidate.kind);
                    } else {
                        const found = await info(candidate.profile, candidate.region);
                        const foundArn = found.inferenceProfileArn;
                        if (typeof foundArn !== "string") throw new Error("profile ARN");
                        await add(
                            foundArn,
                            candidate.region,
                            found.type === "SYSTEM_DEFINED" ? "system" : "application",
                        );
                    }
                } catch (error) {
                    explicitErrors.push({ profile: candidate.profile, message: profileFailureMessage(error) });
                }
            });
            profiles.sort((a, b) => (a.arn < b.arn ? -1 : a.arn > b.arn ? 1 : 0));
            const failed = profiles.length === 0 && explicitErrors.length > 0;
            if (mode === "tag" && profiles.length === 0) {
                const active = activeKey === undefined ? "" : ` and ${activeKey}=${activeValue}`;
                warnings.push(
                    `No application inference profiles matched ${config.tagKey ?? "Team"}=${config.tagValue}${active} in ${config.regions.join(", ")}. Check bedrock.tagKey/tagValue.`,
                );
            }
            if (mode === "system" && profiles.length === 0)
                warnings.push(`No AWS-defined Claude inference profiles in ${config.regions.join(", ")}.`);
            if (failed) {
                lastFailure = problemSummary(explicitErrors) ?? "Could not read any Bedrock profile.";
                return "unavailable";
            }
            const catalog: Catalog = {
                schema: 1,
                mode,
                team: config.team,
                aws_profile: config.profile ?? "",
                account_id: account,
                regions: config.regions,
                fetched_at: Math.floor(now() / 1000),
                filter_hash: filterHash(scope()),
                ...(warnings.length > 0 ? { warnings } : {}),
                profiles,
                ...(explicitErrors.length > 0 ? { errors: explicitErrors } : {}),
            };
            atomicCache(file, catalog);
            invalidAccount = false;
            lastFailure = undefined;
            return "ok";
        } catch (e) {
            lastFailure = failureText(e);
            return category(e instanceof StepError ? e.cause : e);
        }
    };
    return {
        load,
        refresh: (force = false) =>
            (flight ??= perform(force).finally(() => {
                flight = undefined;
            })),
        failure: () => lastFailure,
    };
}
