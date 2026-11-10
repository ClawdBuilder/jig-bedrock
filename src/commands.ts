// User-facing Bedrock commands. Part B adds `/bedrock usage` and `/bedrock budget`; /bedrock-usage and /bedrock-stats
// call the same code. Every block is a title, marker rows, at most one Next, and plain words; without a UI the same text
// goes to standard output.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CatalogSource } from "./aws-discovery.ts";
import type { BedrockModel } from "./catalog.ts";
import type { ResolvedConfig } from "./config.ts";
import { checkLocalDependencies, dependencyLines } from "./doctor.ts";
import { type Markers, markers } from "./markers.ts";
import {
    type ListProfiles,
    LOGIN_PATH,
    NO_PROFILE,
    type ProfileChoice,
    type ProfileResolver,
    sourceLabel,
} from "./profile.ts";
import { saveBudgetSetting } from "./settings-write.ts";
import type { SpendTracker } from "./spend.ts";

type Json = Record<string, unknown>;
const clean = (value: unknown, max = 100): string =>
    String(value ?? "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal and bidi controls from a line
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
        .slice(0, max);
const money = (value: number): string => `$${value.toFixed(2)}`;
const route = (model: BedrockModel | undefined): string =>
    model?.api === "anthropic-messages" ? "Messages" : "Converse";
const usageText = (args: string): "day" | "week" | "month" | undefined => {
    const value = args.trim().toLowerCase();
    if (value === "" || value === "month" || value === "monthly") return "month";
    if (value === "day" || value === "daily" || value === "today") return "day";
    if (value === "week" || value === "weekly") return "week";
    return undefined;
};
function emit(ctx: ExtensionCommandContext, title: string, rows: readonly string[]): void {
    const text = [title, ...rows].map((line) => clean(line)).join("\n");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else process.stdout.write(`${text}\n`);
}
function profileLine(choice: ProfileChoice, m: Markers): string {
    if (choice.ambient === true) return `${m.warn} AWS profile: none chosen; using the environment credential chain`;
    if (choice.profile === undefined) return `${m.fail} AWS profile: none chosen. ${NO_PROFILE}`;
    const source = sourceLabel(choice.source);
    if (choice.problem !== undefined) return `${m.fail} AWS profile: ${choice.profile} (${source}) — ${choice.problem}`;
    if (choice.exists === false)
        return `${m.fail} AWS profile: ${choice.profile} (${source}) — not listed; run ${LOGIN_PATH}`;
    return `${m.ok} AWS profile: ${choice.profile} (${source})`;
}
function discoveryLine(config: ResolvedConfig, m: Markers): string {
    const mode =
        config.mode === "explicit"
            ? `explicit list${config.profiles?.length ? ` (${config.profiles.length})` : ""}`
            : config.mode === "tag"
              ? `tag ${config.tagKey}=${config.tagValue}`
              : "AWS-defined";
    return `${m.ok} Discovery: ${mode} · regions: ${config.regions.join(", ")}`;
}

export interface BedrockCommandSources {
    config: ResolvedConfig;
    spend: SpendTracker;
    catalog: CatalogSource;
    models(): BedrockModel[];
    profiles?: ProfileResolver;
    stored?: () => string | undefined;
    listProfiles?: ListProfiles;
    check?: typeof checkLocalDependencies;
    env?: NodeJS.ProcessEnv;
    migrate?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
export type BedrockCommand = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

export function registerBedrockCommands(pi: ExtensionAPI, sources: BedrockCommandSources): { bedrock: BedrockCommand } {
    const { config, spend } = sources;
    const env = sources.env ?? process.env;

    const usage = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const period = usageText(args);
        if (period === undefined) {
            emit(ctx, "Bedrock spend", ["✗ Unknown period.", "Next: /bedrock usage month"]);
            return;
        }
        await spend.report(period, ctx);
    };
    const budget = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const value = args.trim();
        if (value === "") {
            await spend.budgetReport(ctx);
            return;
        }
        if (value === "off") {
            config.monthlyBudgetUsd = undefined;
            const saved = saveBudgetSetting(env, undefined);
            emit(ctx, "Bedrock budget", [
                saved.ok ? "✓ Budget removed." : `✗ ${saved.error}`,
                "! Not an AWS limit; no request is blocked.",
                "Next: /bedrock budget 200",
            ]);
            spend.updateFooter(ctx);
            return;
        }
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount <= 0) {
            emit(ctx, "Bedrock budget", [
                "✗ The budget must be a positive number of dollars.",
                "Next: /bedrock budget 200",
            ]);
            return;
        }
        config.monthlyBudgetUsd = amount;
        const saved = saveBudgetSetting(env, amount);
        emit(ctx, "Bedrock budget", [
            saved.ok ? `✓ Budget set to ${money(amount)}.` : `✗ ${saved.error}`,
            "! Not an AWS limit; no request is blocked.",
            "Next: /bedrock usage",
        ]);
        spend.updateFooter(ctx);
    };
    const profiles = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (args.trim() !== "") {
            emit(ctx, "Bedrock profiles", ["✗ Usage: /bedrock profiles"]);
            return;
        }
        const catalog = sources.catalog.load();
        const models = sources.models();
        const m = markers(env);
        emit(ctx, "Bedrock profiles", [
            catalog
                ? `${m.ok} ${catalog.profiles.length} profiles · ${models.length} models · observed ${new Date(catalog.fetched_at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
                : `${m.warn} Catalog: not loaded. Run /bedrock-refresh.`,
            `${m.ok} AWS profile: ${config.profile === undefined ? "none chosen" : clean(config.profile)}`,
            discoveryLine(config, m),
            "– Prices: Pi's model registry; no price means the reply counts as unpriced.",
            ...models.slice(0, 3).map((model) => `✓ ${clean(model.id, 60)} · ${route(model)} · ${model.rateSource}`),
            "Next: /bedrock-refresh",
        ]);
    };
    const doctor = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (args.trim() !== "") {
            emit(ctx, "Bedrock doctor", ["✗ Usage: /bedrock doctor"]);
            return;
        }
        const health = await (sources.check ?? checkLocalDependencies)({ signal: ctx.signal, env });
        const m = markers(env);
        let choice: ProfileChoice = sources.profiles
            ? await sources.profiles.resolve({ stored: sources.stored?.(), signal: ctx.signal })
            : { profile: config.profile };
        if (choice.profile !== undefined && choice.exists === undefined && sources.listProfiles) {
            const listed = await sources.listProfiles(ctx.signal);
            if (listed !== undefined) choice = { ...choice, exists: listed.includes(choice.profile) };
        }
        emit(ctx, "Bedrock doctor", [
            ...dependencyLines(health).map(
                (line, index) =>
                    `${index <= 1 && health[index === 0 ? "node" : "aws"].status !== "ready" ? m.fail : m.ok} ${line}`,
            ),
            profileLine(choice, m),
            discoveryLine(config, m),
            sources.catalog.load() ? `${m.ok} Catalog: loaded` : `${m.skip} Catalog: not loaded`,
            `${config.spendCommand === undefined ? m.skip : spend.commandStatus().startsWith("ok") ? m.ok : m.warn} Spend command: ${spend.commandStatus()}`,
            "Only local checks; no AWS call, credential read or model invocation.",
        ]);
    };
    const full: BedrockCommand = async (args, ctx) => {
        const [command = "", ...rest] = args.trim().split(/\s+/);
        const tail = rest.join(" ");
        switch (command) {
            case "":
            case "usage":
                await usage(tail, ctx);
                return;
            case "budget":
                await budget(tail, ctx);
                return;
            case "profiles":
                await profiles(tail, ctx);
                return;
            case "doctor":
                await doctor(tail, ctx);
                return;
            case "migrate":
                if (sources.migrate) await sources.migrate("migrate", ctx);
                else emit(ctx, "Bedrock", ["! No 0.2.x settings to migrate."]);
                return;
            default:
                emit(ctx, "Bedrock", ["✗ Unknown command.", "Next: /bedrock usage"]);
        }
    };
    pi.registerCommand("bedrock-usage", {
        description: "Show this machine's Bedrock spend and the optional spend command",
        handler: (args, ctx) => usage(args, ctx),
    });
    pi.registerCommand("bedrock-stats", {
        description: "Show this machine's Bedrock spend (same as /bedrock usage)",
        handler: (args, ctx) => usage(args, ctx),
    });
    pi.registerCommand("bedrock-profiles", {
        description: "Show the discovered Bedrock profiles and models",
        handler: (args, ctx) => profiles(args, ctx),
    });
    pi.registerCommand("bedrock-doctor", {
        description: "Check local dependencies, the AWS profile and the catalog without network calls",
        handler: (args, ctx) => doctor(args, ctx),
    });
    return { bedrock: full };
}
