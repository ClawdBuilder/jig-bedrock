import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CatalogSource } from "./aws-discovery.ts";
import type { BudgetSource } from "./budget.ts";
import type { TeamBedrockModel } from "./catalog.ts";
import type { ResolvedConfig } from "./config.ts";
import { checkLocalDependencies, dependencyLines } from "./doctor.ts";
import { cacheWriteRate } from "./prompt-cache.ts";
import {
    periodLabels,
    pricedSpend,
    type StatisticsSource,
    type UsagePeriod,
    type UsageReport,
    type UsageSnapshot,
} from "./statistics.ts";
import { UsageError } from "./usage.ts";

// biome-ignore lint/suspicious/noExplicitAny: Pi's session records, checked field by field where they are used
type Json = any;
const clean = (value: unknown, max = 256) =>
    String(value ?? "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal and bidi controls from a line
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
        .slice(0, max);
const count = (value: number) => value.toLocaleString("en-US");
const money = (value: number | null) => (value === null ? "unknown (unpriced usage)" : `$${value.toFixed(4)}`);
/** usage program leaves the total null when any row is unpriced; the priced rows are still real spend, so show them as a lower bound. */
const totalCost = (report: UsageReport) => {
    const { spentUsd } = pricedSpend(report);
    return report.totals.costUsd === null && spentUsd > 0
        ? `${money(spentUsd)} + unpriced usage`
        : money(report.totals.costUsd);
};
/** The 5-minute cache write rate and, for models with a 1-hour tier (PI_CACHE_RETENTION=long), Pi's 1-hour rate: twice the input rate. */
function writeRates(m: TeamBedrockModel): string {
    const rate = (value: number) => String(Number(value.toFixed(4)));
    if (m.promptCache?.long === undefined)
        return `write $${rate(m.cost.cacheWrite)}${m.promptCache ? " (5 min only)" : ""}`;
    return `write $${rate(m.cost.cacheWrite)} (5 min) / $${rate(cacheWriteRate(m.cost, 0, "long"))} (1 h)`;
}
export function usageLines(snapshot: UsageSnapshot): string[] {
    const { report, observedAt } = snapshot,
        t = report.totals;
    return [
        `usage program user estimate · ${periodLabels[report.period]} (UTC) · ${snapshot.stale ? "STALE" : "fresh"}`,
        `User: ${clean(report.user)} · observed ${new Date(observedAt).toISOString()} · contract ${report.contract}`,
        "Scope: this AWS user's inference profiles; excludes other users and is not a team total.",
        `Requests ${count(t.requests)} · fresh input ${count(t.inputFresh)} · output ${count(t.output)}`,
        `Cache read ${count(t.cacheRead)} · cache write ${count(t.cacheWrite)} · total input ${count(t.input)}`,
        `Estimated cost: ${totalCost(report)}. AWS metrics may arrive late.`,
        ...(snapshot.refreshFailed ? ["Last refresh failed; showing the last valid report."] : []),
        "Models / inference profiles:",
        ...report.profiles.flatMap((p) => [
            `${clean(p.model)} · ${clean(p.name)}`,
            `  ${count(p.requests)} requests · ${money(p.costUsd)}`,
            `  Fresh input ${count(p.inputFresh)} · output ${count(p.output)} · cache read ${count(p.cacheRead)} / write ${count(p.cacheWrite)}`,
        ]),
        ...(!report.profiles.length ? ["No usage reported for this period."] : []),
    ];
}
function sessionLines(ctx: ExtensionCommandContext): string[] {
    let requests = 0,
        input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
        costUsd = 0,
        unknown = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
        const message = entry.type === "message" ? (entry as { message?: Json }).message : undefined;
        if (message?.role !== "assistant" || !["jig-bedrock", "amazon-bedrock"].includes(message.provider)) continue;
        const usage = message.usage;
        if (!usage) continue;
        requests++;
        for (const [key, add] of [
            [
                "input",
                (n: number) => {
                    input += n;
                },
            ],
            [
                "output",
                (n: number) => {
                    output += n;
                },
            ],
            [
                "cacheRead",
                (n: number) => {
                    cacheRead += n;
                },
            ],
            [
                "cacheWrite",
                (n: number) => {
                    cacheWrite += n;
                },
            ],
        ] as const) {
            const value = usage[key];
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) add(value);
        }
        if (typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0)
            costUsd += usage.cost.total;
        else unknown++;
    }
    return [
        "Current Pi branch · Bedrock only (local session records)",
        `${count(requests)} responses · input ${count(input)} · output ${count(output)} · cache read ${count(cacheRead)} / write ${count(cacheWrite)}`,
        `Pi estimated cost: $${costUsd.toFixed(4)}${unknown ? ` + ${unknown} unpriced responses` : ""}. This is separate from usage program's user estimate.`,
    ];
}
/** A local dialog owns the request and cancels it when dismissed; nothing enters model context. */
async function showReport(
    ctx: ExtensionCommandContext,
    title: string,
    load: (signal: AbortSignal) => Promise<string[]>,
    active: Set<AbortController>,
): Promise<void> {
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    ctx.signal?.addEventListener("abort", abort, { once: true });
    const rows = async () => {
        try {
            return await load(controller.signal);
        } catch (error) {
            return [error instanceof UsageError ? error.message : "Report unavailable. Run /bedrock-doctor and retry."];
        }
    };
    try {
        if (ctx.signal?.aborted) controller.abort();
        if (ctx.mode !== "tui" || !ctx.ui.custom) {
            if (!controller.signal.aborted) {
                const body = await rows();
                if (!controller.signal.aborted) ctx.ui.notify(body.map((row) => clean(row, 1024)).join("\n"), "info");
            }
            return;
        }
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
            let body = ["Loading…"],
                offset = 0,
                closed = false;
            const close = () => {
                if (closed) return;
                closed = true;
                controller.abort();
                done();
            };
            controller.signal.addEventListener("abort", close, { once: true });
            const component = {
                invalidate() {},
                dispose() {
                    closed = true;
                    controller.abort();
                    controller.signal.removeEventListener("abort", close);
                },
                handleInput(data: string) {
                    if (data === "q" || data === "\x1b") {
                        close();
                        return;
                    }
                    if (data === "\x1b[B" || data === "j") offset++;
                    if (data === "\x1b[A" || data === "k") offset = Math.max(0, offset - 1);
                    tui.requestRender();
                },
                render(width: number): string[] {
                    const height = Math.max(4, Math.min(24, tui.terminal.rows - 4)),
                        slots = height - 2,
                        columns = Math.max(1, width);
                    const wrapped = body.flatMap((row) => {
                        const chars = Array.from(clean(row, 1024)),
                            rows: string[] = [];
                        do {
                            rows.push(chars.splice(0, columns).join(""));
                        } while (chars.length);
                        return rows;
                    });
                    offset = Math.min(offset, Math.max(0, wrapped.length - slots));
                    const clip = (row: string) => Array.from(clean(row)).slice(0, Math.max(0, width)).join("");
                    return [
                        theme.fg("accent", clip(title)),
                        ...wrapped.slice(offset, offset + slots),
                        theme.fg("muted", clip("↑/↓ or j/k scroll · q/Esc close")),
                    ];
                },
            };
            if (controller.signal.aborted) {
                queueMicrotask(close);
                return component;
            }
            void rows().then((value) => {
                if (!closed) {
                    body = value;
                    tui.requestRender();
                }
            });
            return component;
        });
    } finally {
        controller.abort();
        active.delete(controller);
        ctx.signal?.removeEventListener("abort", abort);
    }
}
export function registerStatisticsCommands(
    pi: ExtensionAPI,
    sources: {
        config: ResolvedConfig;
        statistics: StatisticsSource;
        catalog: CatalogSource;
        models(): TeamBedrockModel[];
        budget: BudgetSource;
        publish(): void;
    },
): void {
    const { config, statistics } = sources,
        active = new Set<AbortController>();
    const usage = async (period: UsagePeriod, signal: AbortSignal) => {
        try {
            const snapshot = await statistics.refresh(period, { force: true, signal });
            if (period === "monthly") {
                await sources.budget.refresh({ force: true, signal });
                sources.publish();
            }
            return usageLines(snapshot);
        } catch (error) {
            if (signal.aborted) throw new UsageError("cancelled");
            const old = statistics.load(period);
            if (!old) throw error;
            return [
                error instanceof UsageError ? error.message : "Refresh failed.",
                ...usageLines({ ...old, stale: true, refreshFailed: true }),
            ];
        }
    };
    pi.registerCommand("bedrock-usage", {
        description: "usage program user usage: daily | weekly | monthly (default), with tokens and estimated cost",
        handler: async (args, ctx) => {
            const period = args.trim() || "monthly";
            if (!["daily", "weekly", "monthly"].includes(period)) {
                ctx.ui.notify("Usage: /bedrock-usage [daily|weekly|monthly]", "warning");
                return;
            }
            await showReport(
                ctx,
                "Bedrock · usage program usage",
                (signal) => usage(period as UsagePeriod, signal),
                active,
            );
        },
    });
    pi.registerCommand("bedrock-stats", {
        description: "Compare local Pi Bedrock session usage with usage program's monthly user estimate",
        handler: async (args, ctx) => {
            if (args.trim()) {
                ctx.ui.notify("Usage: /bedrock-stats", "warning");
                return;
            }
            await showReport(
                ctx,
                "Bedrock · Statistics",
                async (signal) => [
                    ...sessionLines(ctx),
                    "",
                    ...(await usage("monthly", signal)),
                    ...(config.monthlyBudgetUsd === undefined
                        ? []
                        : [
                              `Personal monthly display budget: $${config.monthlyBudgetUsd}. This is not an AWS quota or enforced spend limit.`,
                          ]),
                ],
                active,
            );
        },
    });
    pi.registerCommand("bedrock-profiles", {
        description: "Show approved team Bedrock models, regions and pricing sources from the current catalog",
        handler: async (args, ctx) => {
            if (args.trim()) {
                ctx.ui.notify("Usage: /bedrock-profiles", "warning");
                return;
            }
            await showReport(
                ctx,
                "Bedrock · Team profiles",
                async () => {
                    const catalog = sources.catalog.load(),
                        models = sources.models();
                    return [
                        `Team: ${clean(config.team)} · AWS profile: ${clean(config.profile)} · regions: ${config.regions.join(", ")}`,
                        catalog
                            ? `Catalog observed ${new Date(catalog.fetched_at * 1000).toISOString()}${Date.now() / 1000 - catalog.fetched_at > 86_400 ? " (stale; /bedrock-refresh)" : ""}. ${catalog.profiles.length} active profiles / ${models.length} usable models.`
                            : "No approved catalog. Run /aws-login, then /bedrock-refresh.",
                        "Catalog tags filter presentation; AWS IAM authorizes model access.",
                        ...models.map(
                            (m) =>
                                `${clean(m.name)} · ${m.arn.split(":")[3]} · ${m.rateSource} / million tokens: input $${m.cost.input}, output $${m.cost.output}, cache read $${m.cost.cacheRead}, ${writeRates(m)}`,
                        ),
                    ];
                },
                active,
            );
        },
    });
    pi.registerCommand("bedrock-doctor", {
        description:
            "Check local dependency versions, optional usage program setup and catalog health without AWS calls or reading credentials",
        handler: async (args, ctx) => {
            if (args.trim()) {
                ctx.ui.notify("Usage: /bedrock-doctor", "warning");
                return;
            }
            await showReport(
                ctx,
                "Bedrock · Local health",
                async (signal) => {
                    const h = await checkLocalDependencies(config, { signal }),
                        cached = statistics.load("monthly");
                    return [
                        "Local checks only; no AWS calls, credential reads, login or model invocation.",
                        ...dependencyLines(h),
                        `Team/profile configuration: loaded · configured regions: ${config.regions.length} · approved catalog: ${sources.catalog.load() ? "loaded" : "unavailable"}`,
                        cached
                            ? `usage program report contract: ${cached.report.contract} · ${cached.stale ? "stale" : "fresh"} · ${cached.refreshFailed ? "last refresh failed" : "last refresh succeeded"}`
                            : "usage program report: unavailable; /bedrock-usage tests the read-only statistics path.",
                        ...(!h.usage || h.bash.status !== "ready" || h.jq.status !== "ready"
                            ? [
                                  "Install usage program's prerequisites and set usageDir to the directory containing its executable usage file. Shell aliases and RC functions are not used.",
                              ]
                            : []),
                        "usage program is optional for model use. /aws-login handles sign-in; /bedrock-refresh refreshes the catalog.",
                    ];
                },
                active,
            );
        },
    });
    pi.on("session_shutdown", () => {
        for (const controller of active) controller.abort();
        active.clear();
    });
}
