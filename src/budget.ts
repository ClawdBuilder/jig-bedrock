import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicCache } from "./cache.ts";
import { boundedRegular } from "./catalog.ts";
import type { ResolvedConfig } from "./config.ts";
import { createStatistics, parseUsage, pricedSpend, type StatisticsSource } from "./statistics.ts";
import { runUsage, type UsageRunner } from "./usage.ts";
/** spentUsd sums the priced rows; unpriced says some usage had no price, so the real spend is higher. */
export interface Budget {
    monthUtc: string;
    spentUsd: number;
    unpriced: boolean;
    limitUsd?: number;
    remainingUsd?: number;
    observedAt: number;
    refreshFailed: boolean;
}
export interface BudgetSource {
    load(): Budget | undefined;
    refresh(options?: { force?: boolean; signal?: AbortSignal }): Promise<void>;
}
export function parseBudget(output: string, monthUtc: string, observedAt: number, limitUsd?: number): Budget {
    if (new Date(observedAt).toISOString().slice(0, 7) !== monthUtc)
        throw new Error("usage program monthly result unavailable");
    const { spentUsd, unpriced } = pricedSpend(parseUsage(output, "monthly"));
    return {
        monthUtc,
        spentUsd,
        unpriced,
        observedAt,
        refreshFailed: false,
        ...(limitUsd === undefined ? {} : { limitUsd, remainingUsd: limitUsd - spentUsd }),
    };
}
export function createBudget(
    config: ResolvedConfig,
    runner: UsageRunner = runUsage,
    file = join(homedir(), ".cache/jig-bedrock/budget.json"),
    now = Date.now,
    statistics: StatisticsSource = createStatistics(config, runner, dirname(file), now),
): BudgetSource {
    const scope = JSON.stringify({
        profile: config.profile,
        team: config.team,
        regions: [...config.regions].sort(),
        usageDir: config.usageDir,
    });
    let flight: Promise<void> | undefined,
        lastAttempt = -Infinity;
    const raw = () => {
        try {
            return JSON.parse(boundedRegular(file, 32768, true) || "{}");
        } catch {
            return {};
        }
    };
    const load = (): Budget | undefined => {
        const c = raw();
        if (
            c.schema !== 1 ||
            c.profile !== config.profile ||
            c.scope !== scope ||
            c.monthUtc !== new Date(now()).toISOString().slice(0, 7) ||
            !Number.isFinite(c.spentUsd) ||
            c.spentUsd < 0 ||
            !Number.isSafeInteger(c.observedAt) ||
            c.observedAt < 0 ||
            c.observedAt > now()
        )
            return;
        return {
            monthUtc: c.monthUtc,
            spentUsd: c.spentUsd,
            unpriced: c.unpriced === true,
            observedAt: c.observedAt,
            refreshFailed: c.refreshFailed === true,
            ...(config.monthlyBudgetUsd === undefined
                ? {}
                : { limitUsd: config.monthlyBudgetUsd, remainingUsd: config.monthlyBudgetUsd - c.spentUsd }),
        };
    };
    const fromSnapshot = (snapshot: ReturnType<StatisticsSource["load"]>) =>
        snapshot && { ...pricedSpend(snapshot.report), observedAt: snapshot.observedAt };
    const perform = async (options: { force?: boolean; signal?: AbortSignal } = {}) => {
        const old = raw(),
            started = now(),
            monthUtc = new Date(started).toISOString().slice(0, 7);
        if (
            !options.force &&
            started - Math.max(lastAttempt, old.scope === scope ? old.lastAttemptAt || 0 : 0) < 300_000
        )
            return;
        lastAttempt = started;
        try {
            const snapshot = await statistics.refresh("monthly", { signal: options.signal });
            atomicCache(file, {
                schema: 1,
                scope,
                profile: config.profile,
                monthUtc,
                lastAttemptAt: started,
                observedAt: snapshot.observedAt,
                refreshFailed: false,
                ...pricedSpend(snapshot.report),
            });
        } catch {
            // Keep the last known figure: this file's own, or else the last valid usage program report the statistics cache still holds.
            const known = load() ?? fromSnapshot(statistics.load("monthly"));
            try {
                atomicCache(file, {
                    schema: 1,
                    scope,
                    profile: config.profile,
                    monthUtc,
                    lastAttemptAt: started,
                    refreshFailed: true,
                    ...(known && { spentUsd: known.spentUsd, unpriced: known.unpriced, observedAt: known.observedAt }),
                });
            } catch {}
        }
    };
    return {
        load,
        refresh: (options) =>
            (flight ??= perform(options).finally(() => {
                flight = undefined;
            })),
    };
}
