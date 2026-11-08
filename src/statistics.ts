import { homedir } from "node:os";
import { join } from "node:path";
import { atomicCache } from "./cache.ts";
import { boundedRegular } from "./catalog.ts";
import type { ResolvedConfig } from "./config.ts";
import {
    executableExists,
    executableOnPath,
    runUsage,
    UsageError,
    type UsageFailure,
    type UsageRunner,
    usageExecutable,
} from "./usage.ts";

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON from the AWS CLI or usage program, checked field by field where it is used
type Json = any;

export type UsagePeriod = "daily" | "weekly" | "monthly";
export const periodLabels: Record<UsagePeriod, string> = {
    daily: "Today",
    weekly: "Last 7 Days",
    monthly: "Current Month",
};
export interface UsageTotals {
    requests: number;
    inputFresh: number;
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    costUsd: number | null;
}
export interface UsageProfile extends UsageTotals {
    model: string;
    name: string;
}
export interface UsageReport {
    user: string;
    period: UsagePeriod;
    totals: UsageTotals;
    profiles: UsageProfile[];
    contract: "v1" | "legacy";
}
export interface UsageSnapshot {
    report: UsageReport;
    observedAt: number;
    stale: boolean;
    refreshFailed: boolean;
}
export interface StatisticsSource {
    load(period: UsagePeriod): UsageSnapshot | undefined;
    refresh(period: UsagePeriod, options?: { force?: boolean; signal?: AbortSignal }): Promise<UsageSnapshot>;
    health(): { usage: boolean; aws: boolean; bash: boolean; jq: boolean };
}
const label = (v: unknown, max = 256): v is string =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: usage labels reject control characters
    typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const cost = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
function totals(value: Json, summary: boolean): UsageTotals {
    const names = summary
        ? [
              "total_requests",
              "total_input_tokens_fresh",
              "total_cache_read_tokens",
              "total_cache_write_tokens",
              "total_input_tokens",
              "total_output_tokens",
              "total_estimated_cost_usd",
          ]
        : [
              "requests",
              "input_tokens_fresh",
              "cache_read_tokens",
              "cache_write_tokens",
              "total_input_tokens",
              "output_tokens",
              "estimated_cost_usd",
          ];
    if (!value || !names.slice(0, 6).every((k) => count(value[k])) || !cost(value[names[6] as string]))
        throw new UsageError("invalid_result");
    const [requests, inputFresh, cacheRead, cacheWrite, input, output, costUsd] = names.map((k) => value[k]);
    if (!Number.isSafeInteger(inputFresh + cacheRead + cacheWrite) || input !== inputFresh + cacheRead + cacheWrite)
        throw new UsageError("invalid_result");
    return { requests, inputFresh, cacheRead, cacheWrite, input, output, costUsd };
}
/**
 * What was spent on the rows that have a price. usage program leaves the summary cost null as soon as one row is unpriced (a model it has
 * no rate for), which would hide hundreds of dollars of known spend behind one unknown row; the footer shows the priced sum
 * and marks it as a lower bound instead.
 */
export function pricedSpend(report: UsageReport): { spentUsd: number; unpriced: boolean } {
    return {
        spentUsd: report.profiles.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
        unpriced: report.profiles.some((row) => row.costUsd === null),
    };
}
function normalize(value: Json, period: UsagePeriod): UsageReport {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !label(value.user) ||
        value.period !== periodLabels[period] ||
        !Array.isArray(value.profiles) ||
        value.profiles.length > 256
    )
        throw new UsageError("invalid_result");
    const contract =
        value.schema_version === undefined && value.command === undefined
            ? "legacy"
            : value.schema_version === 1 && value.command === "usage"
              ? "v1"
              : undefined;
    if (!contract) throw new UsageError("invalid_result");
    const profiles: UsageProfile[] = value.profiles.map((row: Json) => {
        if (
            !row ||
            row.user !== value.user ||
            !(label(row.model_slug) || (row.model_slug === "" && row.estimated_cost_usd === null)) ||
            !label(row.profile_name)
        )
            throw new UsageError("invalid_result");
        return { model: row.model_slug || "Unknown model", name: row.profile_name, ...totals(row, false) };
    });
    const summary =
        value.summary === undefined && !profiles.length && contract === "legacy"
            ? { requests: 0, inputFresh: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, costUsd: null }
            : totals(value.summary, true);
    for (const key of ["requests", "inputFresh", "cacheRead", "cacheWrite", "input", "output"] as const) {
        const sum = profiles.reduce((n, p) => n + p[key], 0);
        if (!Number.isSafeInteger(sum) || sum !== summary[key]) throw new UsageError("invalid_result");
    }
    if (profiles.some((p) => p.costUsd === null) && summary.costUsd !== null) throw new UsageError("invalid_result");
    if (summary.costUsd !== null) {
        const sum = profiles.reduce((total, row) => total + (row.costUsd ?? 0), 0);
        // usage program sums priced rows; allow only floating-point representation noise.
        const tolerance = Math.max(1e-8, Number.EPSILON * Math.max(1, sum) * Math.max(1, profiles.length) * 4);
        if (!Number.isFinite(sum) || Math.abs(sum - summary.costUsd) > tolerance)
            throw new UsageError("invalid_result");
    }
    return { user: value.user, period, totals: summary, profiles, contract };
}
/** v1 is one JSON object. Only legacy usage program may prefix the object with human-readable text. */
export function parseUsage(output: string, period: UsagePeriod): UsageReport {
    if (Buffer.byteLength(output) > 2_097_152) throw new UsageError("invalid_result");
    try {
        return normalize(JSON.parse(output), period);
    } catch (error) {
        if (error instanceof UsageError) throw error;
    }
    let candidates = 0;
    for (let index = output.indexOf("{"); index >= 0 && candidates++ < 256; index = output.indexOf("{", index + 1)) {
        try {
            const value = JSON.parse(output.slice(index));
            if (value.schema_version !== undefined || value.command !== undefined)
                throw new UsageError("invalid_result");
            return normalize(value, period);
        } catch (error) {
            if (error instanceof UsageError) throw error;
        }
    }
    throw new UsageError("invalid_result");
}
function cacheReport(value: Json): UsageReport {
    if (!value || !["v1", "legacy"].includes(value.contract)) throw new UsageError("invalid_result");
    const fields = (t: Json, summary: boolean) =>
        summary
            ? {
                  total_requests: t.requests,
                  total_input_tokens_fresh: t.inputFresh,
                  total_cache_read_tokens: t.cacheRead,
                  total_cache_write_tokens: t.cacheWrite,
                  total_input_tokens: t.input,
                  total_output_tokens: t.output,
                  total_estimated_cost_usd: t.costUsd,
              }
            : {
                  requests: t.requests,
                  input_tokens_fresh: t.inputFresh,
                  cache_read_tokens: t.cacheRead,
                  cache_write_tokens: t.cacheWrite,
                  total_input_tokens: t.input,
                  output_tokens: t.output,
                  estimated_cost_usd: t.costUsd,
              };
    return normalize(
        {
            ...(value.contract === "v1" ? { schema_version: 1, command: "usage" } : {}),
            user: value.user,
            period: periodLabels[value.period as UsagePeriod],
            summary: fields(value.totals, true),
            profiles: value.profiles.map((p: Json) => ({
                user: value.user,
                model_slug: p.model,
                profile_name: p.name,
                ...fields(p, false),
            })),
        },
        value.period,
    );
}
export function createStatistics(
    config: ResolvedConfig,
    runner: UsageRunner = runUsage,
    directory = join(homedir(), ".cache/jig-bedrock"),
    now = Date.now,
): StatisticsSource {
    const scope = JSON.stringify({
        profile: config.profile,
        team: config.team,
        regions: [...config.regions].sort(),
        executable: usageExecutable(config),
    });
    const file = (period: UsagePeriod) => join(directory, `usage-${period}.json`);
    const window = (period: UsagePeriod, observedAt: number) =>
        new Date(observedAt).toISOString().slice(0, period === "monthly" ? 7 : 10);
    const load = (period: UsagePeriod): UsageSnapshot | undefined => {
        try {
            const value = JSON.parse(boundedRegular(file(period), 1_048_576, true) || "{}");
            if (
                value.schema !== 1 ||
                value.scope !== scope ||
                !Number.isSafeInteger(value.observedAt) ||
                value.observedAt < 0 ||
                value.observedAt > now() ||
                window(period, value.observedAt) !== window(period, now()) ||
                value.report?.period !== period
            )
                return;
            const report = cacheReport(value.report);
            return {
                report,
                observedAt: value.observedAt,
                stale: now() - value.observedAt > 300_000 || value.refreshFailed === true,
                refreshFailed: value.refreshFailed === true,
            };
        } catch {
            return;
        }
    };
    let background: Promise<UsageSnapshot> | undefined;
    const perform = async (
        period: UsagePeriod,
        options: { force?: boolean; signal?: AbortSignal },
    ): Promise<UsageSnapshot> => {
        if (options.signal?.aborted) throw new UsageError("cancelled");
        const started = now(),
            previous = load(period);
        if (!options.force && previous && !previous.stale) return previous;
        try {
            const output = await runner(
                usageExecutable(config),
                ["usage", `--${period}`, "--output", "json", "--aws-profile", config.profile],
                {
                    timeout: 120_000,
                    maxBuffer: 2_097_152,
                    signal: options.signal,
                    env: {
                        ...process.env,
                        BEDROCK_REGIONS: config.regions.join(","),
                        AWS_PROFILE: config.profile,
                        AWS_CLI_AUTO_PROMPT: "off",
                        AWS_PAGER: "",
                        NO_COLOR: "1",
                        PAT_SKIP_UPDATE_CHECK: "1",
                    },
                },
            );
            if (options.signal?.aborted) throw new UsageError("cancelled");
            const observedAt = now();
            // Legacy reports have no explicit range, so a UTC rollover cannot be safely relabelled.
            if (window(period, started) !== window(period, observedAt)) throw new UsageError("invalid_result");
            const report = parseUsage(output, period);
            atomicCache(file(period), { schema: 1, scope, report, observedAt, refreshFailed: false });
            return { report, observedAt, stale: false, refreshFailed: false };
        } catch (error) {
            const kind: UsageFailure = error instanceof UsageError ? error.kind : "unavailable";
            if (previous && kind !== "cancelled") {
                try {
                    atomicCache(file(period), {
                        schema: 1,
                        scope,
                        report: previous.report,
                        observedAt: previous.observedAt,
                        refreshFailed: true,
                    });
                } catch {}
            }
            throw new UsageError(kind);
        }
    };
    return {
        load,
        health: () => ({
            usage: executableExists(usageExecutable(config)),
            aws: executableOnPath("aws"),
            bash: executableOnPath("bash"),
            jq: executableOnPath("jq"),
        }),
        refresh(period, options = {}) {
            // Background monthly display work shares a flight; interactive commands own their cancellation.
            if (period === "monthly" && !options.force && !options.signal) {
                if (background === undefined) {
                    background = perform(period, options).finally(() => {
                        background = undefined;
                    });
                }
                return background;
            }
            return perform(period, options);
        },
    };
}
