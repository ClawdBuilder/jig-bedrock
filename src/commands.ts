// User-facing Bedrock commands. Part B adds `/bedrock usage` and `/bedrock budget`; /bedrock usage and /bedrock stats
// call the same code. Every block is a title, marker rows, at most one Next, and plain words; without a UI the same text
// goes to standard output.
import { writeSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CatalogSource, Status } from "./aws-discovery.ts";
import { discoveryHelp, partialDiscovery } from "./aws-discovery.ts";
import { keysAdviceNext, signsInWithKeys } from "./aws-profile.ts";
import type { BedrockModel } from "./catalog.ts";
import { routeOf } from "./catalog.ts";
import { isObject } from "./check.ts";
import { DEFAULTS, FIELDS, loadConfig, type ResolvedConfig } from "./config.ts";
import { debugEnabled, debugLogPath } from "./debug-log.ts";
import { checkLocalDependencies } from "./doctor.ts";
import { markers } from "./markers.ts";
import type { ListProfiles, ProfileChoice, ProfileResolver } from "./profile.ts";
import { regionCheck } from "./regions.ts";
import { readSettingsDocument, saveBudgetSetting, writeSettingsDocument } from "./settings-write.ts";
import { formatMoney, monthLabel, type SpendTracker } from "./spend.ts";
import { recoveryHint } from "./sso.ts";

export interface BedrockCommandSpec {
    name: string;
    usage: string;
    summary: string;
}
export const BEDROCK_COMMANDS: readonly BedrockCommandSpec[] = [
    { name: "status", usage: "status", summary: "show the AWS profile, models, spend and budget" },
    {
        name: "doctor",
        usage: "doctor [offline|call]",
        summary: 'check the set-up; "doctor call" sends one tiny request',
    },
    { name: "models", usage: "models", summary: "list the models, routes and prices" },
    { name: "refresh", usage: "refresh", summary: "read the models from AWS again" },
    { name: "login", usage: "login", summary: "renew the chosen AWS sign-in" },
    { name: "usage", usage: "usage [day|week|month]", summary: "show the month, week or day spend by model" },
    { name: "spend", usage: "spend [day|week|month]", summary: "show spend; the same as usage" },
    { name: "budget", usage: "budget [amount|off]", summary: "show, set or remove the display budget" },
    { name: "settings", usage: "settings", summary: "show every setting and its source" },
    { name: "set", usage: "set <key> <value>", summary: "change one setting in bedrock.json" },
    { name: "unset", usage: "unset <key>", summary: "remove one setting from bedrock.json" },
    { name: "migrate", usage: "migrate", summary: "copy a 0.2.x jig.json section once" },
    { name: "use", usage: "use [name]", summary: "switch presets, or list them" },
    { name: "preset", usage: "preset add|remove <name>", summary: "add or remove a preset" },
    { name: "help", usage: "help [name]", summary: "this list" },
] as const;
export const BEDROCK_SUBCOMMANDS = BEDROCK_COMMANDS.map((command) => command.name);
const _HELP: Record<string, string> = Object.fromEntries(
    BEDROCK_COMMANDS.map((command) => [command.name, command.summary]),
);
const usageFor = (name: string): string => BEDROCK_COMMANDS.find((command) => command.name === name)?.usage ?? name;
const clean = (value: unknown, max = 10_000): string =>
    String(value ?? "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal and bidi controls from a line
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
        .slice(0, max);
const money = formatMoney;
const displayPath = (file: string, env: NodeJS.ProcessEnv, max = 80): string => {
    const home = env.HOME;
    const shown = home !== undefined && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
    const text = clean(shown, 10_000);
    if (text.length <= max) return text;
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
};
const route = (model: BedrockModel | undefined, settings: ResolvedConfig): string =>
    model === undefined ? "unknown" : routeOf(model, settings).route === "messages" ? "Messages" : "Converse";
const routeReason = (model: BedrockModel | undefined, settings: ResolvedConfig): string =>
    model === undefined ? "" : routeOf(model, settings).reason;
const usageText = (args: string): "day" | "week" | "month" | undefined => {
    const value = args.trim().toLowerCase();
    if (value === "" || value === "month" || value === "monthly") return "month";
    if (value === "day" || value === "daily" || value === "today") return "day";
    if (value === "week" || value === "weekly") return "week";
    return undefined;
};
function toStdout(ctx: ExtensionCommandContext): boolean {
    return !ctx.hasUI || ctx.mode === "print" || ctx.mode === "json";
}
function noticeLine(ctx: ExtensionCommandContext, text: string): void {
    if (ctx.mode === "print") writeSync(1, `${text}\n`);
    else if (toStdout(ctx)) process.stdout.write(`${text}\n`);
    else ctx.ui.notify(text, "info");
}
function emit(ctx: ExtensionCommandContext, title: string, rows: readonly string[]): void {
    const text = [title, ...rows].map((line) => clean(line)).join("\n");
    if (ctx.mode === "print") writeSync(1, `${text}\n`);
    else if (toStdout(ctx)) process.stdout.write(`${text}\n`);
    else ctx.ui.notify(text, "info");
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
    refresh?: () => Promise<Status>;
    failure?: () => string | undefined;
    login?: () => Promise<void>;
    unavailable?: () => Array<{ profile: string; region: string; reason: string }>;
    /** Reload the settings; `refreshModels` tells the provider a model refresh follows, so its notices stay accurate. */
    apply?: (refreshModels?: boolean) => Promise<void> | void;
    lastChoice?: () => ProfileChoice;
    presetNames?: () => string[];
    presetList?: () => Array<{ name: string; profile?: string; mode?: string; active: boolean; source?: string }>;
    activePreset?: () => { name?: string; source?: string };
    usePreset?: (name: string, ctx: ExtensionCommandContext) => Promise<void>;
    presetAdd?: (name: string, ctx: ExtensionCommandContext) => Promise<void>;
    presetRemove?: (name: string, ctx: ExtensionCommandContext) => Promise<void>;
    loading?: () => boolean;
    doctorAws?: (signal: AbortSignal) => Promise<
        Array<{
            ok: boolean;
            warn?: boolean;
            text: string;
            check: "sign-in" | "models" | "one-profile" | "save";
            next?: string;
        }>
    >;
    discoveryStatus?: () => Status | undefined;
    discoveryMode?: () => string | undefined;
    /** Whether a real AWS answer this session confirmed the sign-in; the profile's presence alone does not. */
    signedIn?: () => boolean;
    /** A stored credential existed earlier this session and is gone now, which is what a real /logout leaves. */
    storedAuthLost?: () => boolean;
    doctorCall?: (signal: AbortSignal) => Promise<{ route: string; ms: number; cacheRead: number; cacheWrite: number }>;
    clearRefusals?: () => number;
    refused?: () => Array<{ arn: string; id: string; date: string }>;
}
export const SETTING_EXAMPLES: Record<string, string> = {
    discovery: "aws-defined",
    regions: "us-east-1",
    profiles: "global.anthropic.claude-sonnet-5-5",
    monthlyBudgetUsd: "200",
    converseModels: "claude-opus-5",
    messagesModels: "claude-sonnet-5-5",
    spendCommand: "node,spend.mjs",
    ssoLoginCommand: "aws,sso,login,--profile,{profile}",
    browser: "/usr/bin/xdg-open",
};

export type BedrockCommand = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const LIST_SETTINGS = new Set([
    "regions",
    "profiles",
    "spendCommand",
    "ssoLoginCommand",
    "converseModels",
    "messagesModels",
]);

function settingValue(key: string, value: string): unknown {
    if (LIST_SETTINGS.has(key))
        return value
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part !== "");
    if (key === "signInAtStart" || key === "debug") return ["true", "on", "yes"].includes(value.toLowerCase());
    if (key === "monthlyBudgetUsd") return Number(value);
    return value;
}

function tokenizeSetting(args: string): string[] {
    const parts: string[] = [];
    for (const match of args.trim().matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g))
        parts.push(match[1] ?? match[2] ?? match[3] ?? "");
    return parts;
}

function parseSettingPairs(args: string): Array<[string, string]> | undefined {
    const parts = tokenizeSetting(args);
    if (parts.length < 2) return undefined;
    if (parts.length === 2) return [[parts[0]!, parts[1]!]];
    if (parts.length % 2 === 0) {
        const pairs: Array<[string, string]> = [];
        for (let i = 0; i < parts.length; i += 2) pairs.push([parts[i]!, parts[i + 1]!]);
        return pairs;
    }
    return [[parts[0]!, parts.slice(1).join(" ")]];
}

export function registerBedrockCommands(
    pi: ExtensionAPI,
    sources: BedrockCommandSources,
): { bedrock: BedrockCommand; completions: (prefix: string) => Array<{ value: string; label: string }> } {
    const { config, spend } = sources;
    const env = sources.env ?? process.env;
    const m = markers(env);

    const usage = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (args.trim() === "" && ctx.mode === "tui" && ctx.hasUI && !toStdout(ctx)) {
            await spendMenu(ctx);
            return;
        }
        const period = usageText(args);
        if (period === undefined) {
            const near = closest(args.trim().toLowerCase(), ["day", "week", "month"]);
            emit(ctx, "Bedrock spend", [
                `${m.fail} Unknown period ${clean(args.trim(), 40)}.${near ? ` Did you mean ${near}?` : ""}`,
                `Usage: /bedrock ${usageFor("usage")}`,
            ]);
            return;
        }
        await spend.report(period, ctx);
    };
    const budget = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const value = args.trim();
        if (value === "" && ctx.mode === "tui" && ctx.hasUI && !toStdout(ctx)) {
            await budgetMenu(ctx);
            return;
        }
        if (value === "") {
            await spend.budgetReport(ctx);
            return;
        }
        if (value === "off") {
            config.monthlyBudgetUsd = undefined;
            const saved = saveBudgetSetting(env, undefined);
            // A changed budget may announce its thresholds again in this month.
            spend.resetBudgetClaims();
            emit(ctx, "Bedrock budget", [
                saved.ok ? `${m.ok} Budget removed.` : `${m.fail} ${saved.error}`,
                `${m.warn} Not an AWS limit; no request is blocked.`,
            ]);
            spend.updateFooter(ctx);
            return;
        }
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 1) {
            emit(ctx, "Bedrock budget", [`${m.fail} The budget must be at least $1.`]);
            return;
        }
        config.monthlyBudgetUsd = amount;
        const saved = saveBudgetSetting(env, amount, config.preset);
        spend.resetBudgetClaims();
        emit(ctx, "Bedrock budget", [
            saved.ok
                ? `${m.ok} Budget set to ${money(amount)}${config.preset === undefined ? "" : ` in preset ${config.preset}`}.`
                : `${m.fail} ${saved.error}`,
            `${m.warn} Not an AWS limit; no request is blocked.`,
        ]);
        spend.updateFooter(ctx);
    };
    // Models Pi has no usable metadata for are not in the list; say how many and where their reasons are.
    const rejectedLine = (): string | undefined => {
        const count = sources.unavailable?.().length ?? 0;
        if (count === 0) return undefined;
        return `${m.warn} ${count} more ${count === 1 ? "is" : "are"} not usable by this Pi: /bedrock models lists them.`;
    };
    const status = async (ctx: ExtensionCommandContext): Promise<void> => {
        const list = sources.models();
        const last = sources.lastChoice?.() ?? { profile: config.profile };
        const view = spend.local("month");
        const limit = config.monthlyBudgetUsd;
        const rows: string[] = [];
        let problems = 0;
        if (config.presetUnknown !== undefined) {
            rows.push(
                `${m.fail} Preset: ${clean(config.presetUnknown)} is not defined; known: ${(config.presetNames ?? []).join(", ") || "none"}`,
            );
            problems++;
        }
        if (last.profile === undefined) {
            rows.push(`${m.fail} AWS profile: none chosen`);
            problems++;
        } else if (last.exists === false) {
            rows.push(
                `${m.fail} AWS profile: ${clean(last.profile)} is not in the AWS config; run /login to choose another.`,
            );
            problems++;
        } else {
            const label =
                sources.signedIn?.() === true
                    ? "signed in"
                    : last.exists === true
                      ? "in the AWS config"
                      : "sign-in not known yet";
            rows.push(`${m.ok} AWS profile: ${clean(last.profile)} · ${label}`);
        }
        if (sources.loading?.()) rows.push(`${m.skip} Models: loading from AWS…`);
        else if (list.length === 0) {
            rows.push(`${m.fail} Models: not loaded`);
            problems++;
        } else rows.push(`${m.ok} Models: ${list.length} loaded`);
        const rejected = rejectedLine();
        if (rejected !== undefined) rows.push(rejected);
        if (sources.storedAuthLost?.() === true && last.profile !== undefined)
            rows.push(`${m.skip} /logout does not remove bedrock.json; run /bedrock unset profile.`);
        const selected = ctx.model;
        if (selected?.provider === "jig-bedrock") {
            const model = list.find((entry) => entry.id === selected.id);
            if (model) rows.push(`${m.ok} Selected model: ${clean(model.id)} · ${route(model, config)} route`);
            else {
                rows.push(`${m.warn} Selected model is not in your model list: ${clean(selected.id)}`);
                problems++;
            }
        } else if (selected?.provider === undefined || selected.provider === "unknown") {
            rows.push(`${m.skip} Selected model: none chosen`);
        } else {
            rows.push(`${m.skip} Selected model: not a jig-bedrock model`);
        }
        const spendText = `${(monthLabel?.(view.month) ?? view.month).split(" ")[0]} ${money(view.spentUsd)}${limit === undefined ? "" : ` of ${money(limit)}`}`;
        rows.push(`${m.ok} Spend: ${spendText}`);
        if (last.profile === undefined)
            rows.push("Next: /login, choose Amazon Bedrock (jig-bedrock), then /bedrock refresh");
        else if (!sources.loading?.() && list.length === 0) rows.push("Next: /bedrock refresh");
        else if (
            selected?.provider !== undefined &&
            selected.provider !== "jig-bedrock" &&
            selected.provider !== "unknown"
        )
            rows.push("Next: /model, choose a jig-bedrock model");
        emit(ctx, `Bedrock · ${problems === 0 ? "ready" : `${problems} problem${problems === 1 ? "" : "s"}`}`, rows);
    };
    const models = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (args.trim() === "" && ctx.mode === "tui" && ctx.hasUI && !toStdout(ctx)) {
            await modelsMenu(ctx);
            return;
        }
        if (args.trim() !== "") {
            emit(ctx, "Bedrock models", [`${m.fail} Usage: /bedrock ${usageFor("models")}`]);
            return;
        }
        const list = [...sources.models()];
        const regionOf = (model: BedrockModel): string =>
            /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/.exec(model.baseUrl)?.[1] ??
            model.arn.split(":")[3] ??
            "";
        const idWidth = Math.max(10, ...list.map((model) => model.id.length));
        const regionWidth = Math.max(8, ...list.map((model) => regionOf(model).length));
        const priceOf = (model: BedrockModel): string =>
            model.rateSource === "no price" ? "no price" : `$${model.cost.input} / $${model.cost.output}`;
        const priceWidth = Math.max(9, ...list.map((model) => priceOf(model).length));
        const rows = list.map((model) => {
            const line = `${m.ok} ${model.id.padEnd(idWidth)} ${regionOf(model).padEnd(regionWidth)} ${route(model, config).padEnd(8)} ${priceOf(model).padEnd(priceWidth)} ${routeReason(model, config)}`;
            return line;
        });
        const rejected = sources.unavailable?.() ?? [];
        for (const entry of rejected.slice(0, 3)) {
            const hint = /Pi registry has no exact metadata/i.test(entry.reason) ? " · update Pi" : "";
            rows.push(
                `${m.skip} This Pi does not know the model: ${clean(entry.profile, 60)}, ${clean(entry.region, 20)}${hint}`,
            );
        }
        if (rejected.length > 3) rows.push(`${m.skip} ... and ${rejected.length - 3} more`);
        const refused = sources.refused?.() ?? [];
        if (refused.length > 0) {
            rows.push("Refused by AWS for your role");
            for (const entry of refused) rows.push(`${m.warn} ${entry.id} · ${entry.date.slice(0, 10)}`);
        }
        if (list.length === 0) {
            rows.push(`${m.warn} No models loaded.`);
            const status = sources.discoveryStatus?.();
            rows.push(
                status === undefined || status === "ok"
                    ? "Next: /bedrock refresh."
                    : `Next: ${discoveryHelp(status, sources.discoveryMode?.())}`,
            );
        }
        emit(ctx, `Bedrock models · ${list.length} · price per million tokens, in / out`, rows);
    };
    const settings = async (ctx: ExtensionCommandContext): Promise<void> => {
        const doc = readSettingsDocument(env);
        if ("error" in doc) {
            emit(ctx, "Bedrock settings", [
                `${markers(env).fail} Settings file is not valid JSON.`,
                `${markers(env).skip} File: ${displayPath(doc.file, env)}`,
            ]);
            return;
        }
        const shownPath = displayPath(doc.file, env);
        const envNames: Record<string, string> = {
            tagKey: "JIG_BEDROCK_TAG_KEY",
            tagValue: "JIG_BEDROCK_TAG_VALUE",
            profile: "JIG_BEDROCK_PROFILE",
            regions: "JIG_BEDROCK_REGIONS",
            debug: "JIG_BEDROCK_DEBUG",
        };
        const defaults = DEFAULTS as Record<string, unknown>;
        const keys = FIELDS.filter((key) => key !== "team" && key !== "presets");
        const rawPresets = isObject(doc.target.presets) ? (doc.target.presets as Record<string, unknown>) : {};
        const presetBody =
            config.preset !== undefined && isObject(rawPresets[config.preset])
                ? (rawPresets[config.preset] as Record<string, unknown>)
                : {};
        const isSet = (key: string) => {
            if (key === "preset")
                return config.preset === undefined ? undefined : config.presetSource === "env" ? "environment" : "file";
            if (envNames[key] !== undefined && env[envNames[key] as string] !== undefined) return "environment";
            if (config.preset !== undefined && Object.hasOwn(presetBody, key)) return `preset ${config.preset}`;
            if (Object.hasOwn(doc.target, key)) return "file";
            if (Object.hasOwn(defaults, key)) return "default";
            return undefined;
        };
        const show = (key: string, value: unknown): string => {
            if (Array.isArray(value)) {
                if (key === "ssoLoginCommand" || key === "spendCommand") return value.join(" ");
                return value
                    .map((entry) =>
                        typeof entry === "string"
                            ? (sources.models()?.find((model) => model.arn === entry)?.id ?? clean(entry, 80))
                            : String(entry),
                    )
                    .join(", ");
            }
            return String(value);
        };
        const rows = keys
            .map((key) => ({ key, source: isSet(key), value: (config as unknown as Record<string, unknown>)[key] }))
            .sort((a, b) => (a.source === undefined ? 1 : 0) - (b.source === undefined ? 1 : 0))
            .map(({ key, source, value }) =>
                source === undefined
                    ? `${m.skip} ${key}: not set`
                    : `${source === "default" ? m.skip : m.ok} ${key}: ${clean(show(key, value ?? defaults[key]), 55)} (${source})`,
            );
        const title = `Bedrock settings · ${shownPath}`;
        emit(
            ctx,
            title.length <= 100 ? title : "Bedrock settings",
            title.length <= 100 ? rows : [`${m.skip} File: ${shownPath}`, ...rows],
        );
    };
    const parseSetting = (key: string, value: string): unknown => {
        if (
            key === "regions" ||
            key === "profiles" ||
            key === "spendCommand" ||
            key === "ssoLoginCommand" ||
            key === "converseModels" ||
            key === "messagesModels"
        )
            return value
                .split(",")
                .map((part) => part.trim())
                .filter((part) => part !== "");
        if (key === "signInAtStart" || key === "debug") return ["true", "on", "yes"].includes(value.toLowerCase());
        if (key === "monthlyBudgetUsd") return Number(value);
        return value;
    };
    const set = async (args: string, ctx: ExtensionCommandContext, fromMenu = false): Promise<boolean> => {
        const parts: string[] = [];
        for (const match of args.trim().matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g))
            parts.push(match[1] ?? match[2] ?? match[3] ?? "");
        if (parts.length < 2) {
            emit(ctx, "Bedrock settings", [`${m.fail} Usage: /bedrock ${usageFor("set")}`]);
            return false;
        }
        const pairs: Array<[string, string]> = [];
        if (parts.length === 2) pairs.push([parts[0] as string, parts[1] as string]);
        else if (
            parts.length % 2 === 0 &&
            parts.every((part, index) => index % 2 === 0 || !(FIELDS as readonly string[]).includes(part))
        )
            for (let i = 0; i < parts.length; i += 2) pairs.push([parts[i] as string, parts[i + 1] as string]);
        else if ((FIELDS as readonly string[]).includes(parts[0] as string))
            pairs.push([parts[0] as string, parts.slice(1).join(" ")]);
        else {
            emit(ctx, "Bedrock settings", [`${m.fail} Usage: /bedrock ${usageFor("set")}`]);
            return false;
        }
        for (const [key] of pairs) {
            if (!(FIELDS as readonly string[]).includes(key)) {
                const near = closest(key, FIELDS);
                emit(ctx, "Bedrock settings", [
                    `${m.fail} Unknown setting ${clean(key, 60)}.${near ? ` Did you mean ${near}?` : ""}`,
                    `Usage: /bedrock ${usageFor("set")}`,
                ]);
                return false;
            }
        }
        const doc = readSettingsDocument(env);
        if ("error" in doc) {
            emit(ctx, "Bedrock settings", [
                `${m.fail} Settings file is not valid JSON.`,
                `${m.skip} File: ${displayPath(doc.file, env)}`,
            ]);
            return false;
        }
        const presetTarget =
            config.preset === undefined
                ? undefined
                : isObject(doc.target.presets) && isObject(doc.target.presets[config.preset])
                  ? (doc.target.presets[config.preset] as Record<string, unknown>)
                  : undefined;
        if (config.preset !== undefined && presetTarget === undefined) {
            emit(ctx, "Bedrock settings", [`${m.fail} Preset ${config.preset} is not defined.`]);
            return false;
        }
        const regionWarnings: string[] = [];
        for (const [key, value] of pairs) {
            if (key === "signInAtStart" || key === "debug") {
                if (!/^(true|false|on|off|yes|no)$/i.test(value)) {
                    emit(ctx, "Bedrock settings", [`${m.fail} ${key} accepts true, false, on, off, yes or no.`]);
                    return false;
                }
            }
            if (key === "preset") {
                const known = config.presetNames ?? [];
                if (!known.includes(value)) {
                    emit(ctx, "Bedrock settings", [
                        `${m.fail} Unknown preset ${clean(value, 40)}. Known presets: ${known.sort().join(", ") || "none"}.`,
                    ]);
                    return false;
                }
            }
            const parsed = parseSetting(key, value);
            if (key === "regions") {
                const check = regionCheck(parsed as string[]);
                if (check.problem !== undefined) {
                    emit(ctx, "Bedrock settings", [
                        `${m.fail} ${check.problem}`,
                        ...(fromMenu ? [] : [`Usage: /bedrock ${usageFor("set")}`]),
                    ]);
                    return false;
                }
                regionWarnings.push(...check.warnings);
            }
            if (key === "monthlyBudgetUsd" && (typeof parsed !== "number" || parsed < 1)) {
                emit(ctx, "Bedrock settings", [`${m.fail} The budget must be at least $1.`]);
                return false;
            }
            (presetTarget ?? doc.target)[key] = parsed;
        }
        const candidate = loadConfig({ raw: doc.target, env });
        if (!candidate.config) {
            const error = candidate.error ?? "The settings are not valid.";
            const pair = /activeTagKey and activeTagValue|tagKey and tagValue/.exec(error);
            emit(ctx, "Bedrock settings", [
                `${m.fail} ${
                    fromMenu
                        ? `${pairs[0]?.[0] ?? "Value"}: value not accepted.`
                        : pair
                          ? `${pair[0]} go together: /bedrock set ${pair[0] === "activeTagKey and activeTagValue" ? "activeTagKey <key> activeTagValue <value>" : "tagKey <key> tagValue <value>"}`
                          : error
                }`,
                ...(fromMenu ? [] : [`Usage: /bedrock ${usageFor("set")}`]),
            ]);
            return false;
        }
        const saved = writeSettingsDocument(env, doc.document);
        if (!saved.ok) {
            emit(ctx, "Bedrock settings", [`${m.fail} ${saved.error}`]);
            return false;
        }
        const beforeModels = sources.models().map((model) => model.id);
        const needsRefresh = pairs.some(([key]) =>
            [
                "discovery",
                "team",
                "profile",
                "regions",
                "tagKey",
                "tagValue",
                "activeTagKey",
                "activeTagValue",
                "profiles",
            ].includes(key),
        );
        await sources.apply?.(needsRefresh);
        const shown = pairs.map(([key, value]) => `${key}: ${clean(value, 30)}`).join(", ");
        const savedWhere = config.preset === undefined ? "saved to bedrock.json" : `saved to preset ${config.preset}`;
        const overridden = pairs
            .map(([key]) => {
                const envName: Record<string, string> = {
                    regions: "JIG_BEDROCK_REGIONS",
                    profile: "JIG_BEDROCK_PROFILE",
                    tagKey: "JIG_BEDROCK_TAG_KEY",
                    tagValue: "JIG_BEDROCK_TAG_VALUE",
                    debug: "JIG_BEDROCK_DEBUG",
                    preset: "JIG_BEDROCK_PRESET",
                };
                const name = envName[key];
                return name !== undefined && env[name] !== undefined ? `${name}=${env[name]}` : undefined;
            })
            .filter((value): value is string => value !== undefined);
        emit(ctx, "Bedrock settings", [
            `${m.ok} ${shown} (${savedWhere})`,
            ...(overridden.length > 0
                ? [`${m.warn} Saved, but ${overridden.join(", ")} is in use for this session.`]
                : []),
            ...regionWarnings.map((warning) => `${m.warn} ${warning}`),
            ...(needsRefresh ? ["Saved. Loading models for the new settings…"] : []),
        ]);
        if (needsRefresh) await refresh("", ctx, beforeModels, false);
        const preset = pairs.find(([key]) => key === "preset")?.[1];
        if (preset !== undefined) await sources.usePreset?.(preset, ctx);
        return true;
    };
    const unset = async (args: string, ctx: ExtensionCommandContext, fromMenu = false): Promise<void> => {
        const keys = args.trim().split(/\s+/).filter(Boolean);
        if (keys.length === 0) {
            emit(ctx, "Bedrock settings", [
                `${m.fail} Usage: /bedrock ${usageFor("unset")}`,
                "Usage: /bedrock unset <key> [key...]",
            ]);
            return;
        }
        for (const key of keys) {
            if (!(FIELDS as readonly string[]).includes(key)) {
                const near = closest(key, FIELDS);
                emit(ctx, "Bedrock settings", [
                    `${m.fail} Unknown setting ${clean(key, 60)}.${near ? ` Did you mean ${near}?` : ""}`,
                    `Usage: /bedrock unset <key> [key...]`,
                ]);
                return;
            }
        }
        const doc = readSettingsDocument(env);
        if ("error" in doc) {
            emit(ctx, "Bedrock settings", [
                `${m.fail} Settings file is not valid JSON.`,
                `${m.skip} File: ${displayPath(doc.file, env)}`,
            ]);
            return;
        }
        for (const key of keys) delete doc.target[key];
        const candidate = loadConfig({ raw: doc.target, env });
        if (!candidate.config) {
            emit(ctx, "Bedrock settings", [`${m.fail} ${candidate.error}`, "Next: /bedrock settings"]);
            return;
        }
        const saved = writeSettingsDocument(env, doc.document);
        if (!saved.ok) {
            emit(ctx, "Bedrock settings", [`${m.fail} ${saved.error}`]);
            return;
        }
        const beforeModels = sources.models().map((model) => model.id);
        const needsRefresh = keys.some((key) =>
            [
                "discovery",
                "team",
                "profile",
                "regions",
                "tagKey",
                "tagValue",
                "activeTagKey",
                "activeTagValue",
                "profiles",
            ].includes(key),
        );
        await sources.apply?.(needsRefresh);
        emit(ctx, "Bedrock settings", [
            `${m.ok} ${keys.join(", ")}: unset (saved to bedrock.json)`,
            ...(needsRefresh ? ["Saved. Loading models for the new settings…"] : []),
        ]);
        if (needsRefresh) await refresh("", ctx, beforeModels, false);
    };
    const refresh = async (
        args: string,
        ctx: ExtensionCommandContext,
        changedFrom?: readonly string[],
        reading = true,
    ): Promise<void> => {
        if (args.trim() !== "") {
            emit(ctx, "Bedrock", [`Usage: /bedrock ${usageFor("refresh")}`]);
            return;
        }
        if (!sources.refresh) {
            emit(ctx, "Bedrock refresh", [`${m.fail} No catalog refresh is available in this install.`]);
            return;
        }
        const settingsBefore = changedFrom?.length;
        const before = new Set(changedFrom ?? sources.models().map((model) => model.id));
        const selectedBefore = ctx.model?.provider === "jig-bedrock" ? ctx.model.id : undefined;
        // A settings save already said it is loading the models; one progress line for one action.
        if (ctx.hasUI && !toStdout(ctx) && reading)
            emit(ctx, "Bedrock refresh", [`${m.skip} Reading the models from AWS…`]);
        const cleared = sources.clearRefusals?.() ?? 0;
        const status = await sources.refresh();
        const after = sources.models();
        const added = after.filter((model) => !before.has(model.id)).length;
        const removed = [...before].filter((id) => !after.some((model) => model.id === id)).length;
        const catalog = sources.catalog?.load();
        const warnings = catalog?.warnings ?? [];
        const save = sources.catalog?.saveFailure?.();
        const partial = partialDiscovery(catalog);
        const rejected = rejectedLine();
        if (settingsBefore !== undefined && (status !== "ok" || after.length < settingsBefore)) {
            const left = Math.max(0, settingsBefore - after.length);
            const cause =
                status !== "ok"
                    ? (sources.failure?.() ?? "The models could not be read from AWS.")
                    : [partial?.errors, ...warnings].filter(Boolean).join(" ") ||
                      "The new settings matched fewer models.";
            const next =
                status !== "ok"
                    ? `Next: ${discoveryHelp(sources.discoveryStatus?.() ?? status, sources.discoveryMode?.())}`
                    : "Next: fix the tag or list in /bedrock settings, then /bedrock refresh.";
            emit(ctx, "Bedrock refresh", [
                `${status === "ok" ? m.warn : m.fail} Bedrock: ${after.length} model${after.length === 1 ? "" : "s"} in /model (${left} left). ${cause} ${next}`,
                ...(cleared > 0 ? [`${m.ok} ${cleared} refused model${cleared === 1 ? "" : "s"} offered again.`] : []),
                ...(selectedBefore !== undefined && !after.some((model) => model.id === selectedBefore)
                    ? ["Choose /model if your selection was removed."]
                    : []),
                ...(rejected === undefined ? [] : [rejected]),
                ...(save === undefined ? [] : [`${m.warn} ${save.message}`]),
            ]);
            return;
        }
        if (status !== "ok") {
            const advice = sources.discoveryStatus?.() ?? status;
            emit(ctx, "Bedrock refresh", [
                `${m.fail} ${sources.failure?.() ?? "The models could not be read from AWS."}`,
                `Next: ${discoveryHelp(advice, sources.discoveryMode?.())}`,
            ]);
            return;
        }
        if (after.length === 0 && warnings.length > 0) {
            emit(ctx, "Bedrock refresh", [
                `${m.warn} ${warnings.join(" ")}`,
                "Next: fix the tag or list in /bedrock settings, then /bedrock refresh.",
                ...(rejected === undefined ? [] : [rejected]),
                ...(save === undefined ? [] : [`${m.warn} ${save.message}`]),
            ]);
            return;
        }
        const rows =
            partial === undefined
                ? [
                      `${m.ok} ${after.length} model${after.length === 1 ? "" : "s"} loaded (${added} new, ${removed} gone).`,
                      ...(cleared > 0
                          ? [`${m.ok} ${cleared} refused model${cleared === 1 ? "" : "s"} offered again.`]
                          : []),
                  ]
                : [
                      `${m.warn} ${partial.line}.`,
                      ...(cleared > 0
                          ? [`${m.ok} ${cleared} refused model${cleared === 1 ? "" : "s"} offered again.`]
                          : []),
                  ];
        if (selectedBefore !== undefined && !after.some((model) => model.id === selectedBefore))
            rows.push("Choose /model if your selection was removed.");
        if (partial === undefined) for (const warning of warnings) rows.push(`${m.warn} ${warning}`);
        else {
            if (partial.errors !== undefined) rows.push(`${m.warn} ${partial.errors}`);
            for (const warning of partial.warnings) rows.push(`${m.warn} ${warning}`);
            rows.push("Next: check the failed profile or region in /bedrock settings, then /bedrock refresh.");
        }
        if (rejected !== undefined) rows.push(rejected);
        if (save !== undefined) rows.push(`${m.warn} ${save.message}`);
        emit(ctx, "Bedrock refresh", rows);
    };
    const login = async (ctx: ExtensionCommandContext): Promise<void> => {
        if (!sources.login) {
            emit(ctx, "Bedrock login", [`${m.fail} No sign-in is available in this install.`]);
            return;
        }
        try {
            await sources.login();
            emit(ctx, "Bedrock login", [`${m.ok} Sign-in finished. Models will refresh in the background.`]);
        } catch (error) {
            const raw = error instanceof Error ? error.message : String(error);
            const hint = raw.includes("No AWS profile is chosen") ? raw : recoveryHint(error);
            const profile = sources.lastChoice?.().profile ?? config.profile;
            // A keys profile (or a role over keys) is refused before the sign-in starts; running the same command
            // again cannot change that, so the next step is the AWS CLI check instead.
            const keys =
                profile !== undefined && !hint.includes("No AWS profile is chosen") && signsInWithKeys(profile, env);
            emit(ctx, "Bedrock login", [
                `${m.fail} ${clean(hint, 200)}`,
                ...(hint.includes("No AWS profile is chosen")
                    ? ["Next: /login and choose Amazon Bedrock (jig-bedrock)."]
                    : keys
                      ? [keysAdviceNext(profile, "/bedrock doctor.")]
                      : ["Next: fix the reason above, then run /bedrock login again."]),
            ]);
        }
    };
    const doctor = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (words.some((word) => word !== "offline" && word !== "call")) {
            emit(ctx, "Bedrock doctor", [`${m.fail} Usage: /bedrock ${usageFor("doctor")}`]);
            return;
        }
        const offline = words.includes("offline");
        const call = words.includes("call");
        if (call) noticeLine(ctx, "This sends one tiny request (a fraction of a cent).");
        if (!offline && ctx.hasUI && !toStdout(ctx)) emit(ctx, "Bedrock doctor", [`${m.skip} Checking AWS…`]);
        const health = await (sources.check ?? checkLocalDependencies)({
            signal: ctx.signal,
            env,
            timeout: 15_000,
        });
        const rows: string[] = [];
        const nextSteps: string[] = [];
        if (config.presetUnknown !== undefined)
            rows.push(
                `${m.fail} Preset: ${clean(config.presetUnknown)} is not defined; known: ${(config.presetNames ?? []).join(", ") || "none"}`,
            );
        const node =
            health.node.status === "ready"
                ? `${m.ok} Node ${health.node.version ?? "unknown"}`
                : `${m.fail} Node ${health.node.version ?? "unknown"} (needs 22.19 or later)`;
        rows.push(node);
        if (health.node.status !== "ready") nextSteps.push("Next: upgrade Node to 22.19 or later");
        if (health.aws.status === "ready") rows.push(`${m.ok} AWS CLI ${health.aws.version ?? "unknown"}`);
        else if (health.aws.status === "old") {
            rows.push(`${m.fail} AWS CLI ${health.aws.version ?? "unknown"} (needs v2)`);
            nextSteps.push("Next: install AWS CLI v2");
        } else if (health.aws.status === "missing") {
            rows.push(`${m.fail} AWS CLI: not found. Install AWS CLI v2.`);
            nextSteps.push("Next: install AWS CLI v2");
        } else rows.push(`${m.skip} AWS CLI: could not check`);
        const doc = readSettingsDocument(env);
        const home = env.HOME;
        const file = "file" in doc ? doc.file : join(home ?? "", ".pi/agent/bedrock.json");
        rows.push(`${m.ok} Settings: ${displayPath(file, env, 70)}`);
        const last = sources.lastChoice?.() ?? { profile: config.profile };
        const profile = last.profile ?? config.profile;
        if (profile === undefined) {
            rows.push(`${m.fail} AWS profile: none chosen; run /login`);
            nextSteps.push("Next: /login, choose Amazon Bedrock (jig-bedrock)");
        } else if (last.exists === false) {
            rows.push(`${m.fail} AWS profile: ${clean(profile, 40)} is not in ~/.aws/config; run /login`);
            nextSteps.push("Next: /login, choose Amazon Bedrock (jig-bedrock)");
        } else {
            const source =
                last.source === "env"
                    ? "from JIG_BEDROCK_PROFILE"
                    : last.source === "login"
                      ? "from /login"
                      : last.source === "setting"
                        ? "from bedrock.json"
                        : last.source === "default"
                          ? "from the default profile"
                          : "";
            rows.push(`${m.ok} AWS profile: ${clean(profile)}${source ? ` (${source})` : ""}`);
        }
        let awsRows: Array<{
            ok: boolean;
            warn?: boolean;
            text: string;
            check: "sign-in" | "models" | "one-profile" | "save";
            next?: string;
        }> = [];
        if (offline) rows.push(`${m.skip} AWS not checked: offline`);
        else if (health.aws.status !== "ready") rows.push(`${m.skip} AWS checks: not run (AWS CLI not ready)`);
        else if (sources.doctorAws) awsRows = await sources.doctorAws(ctx.signal ?? new AbortController().signal);
        if (!offline) for (const warning of sources.catalog?.load()?.warnings ?? []) rows.push(`${m.warn} ${warning}`);
        for (const check of awsRows) {
            const text = check.text
                .replace(/^AWS identity: /, "Sign-in: ")
                .replace(/^Inference profiles: /, "Models: ")
                .replace(/^One profile: /, "One inference profile: ");
            rows.push(`${check.warn === true ? m.warn : check.ok ? m.ok : m.fail} ${text}`);
            if (!check.ok) {
                if (check.next !== undefined) nextSteps.push(check.next);
                else if (check.check === "models") {
                    const status = sources.discoveryStatus?.();
                    nextSteps.push(
                        status === undefined || status === "ok"
                            ? "Next: check regions and the tag or explicit list in /bedrock settings, then /bedrock refresh"
                            : `Next: ${discoveryHelp(status, sources.discoveryMode?.())}`,
                    );
                } else if (check.check === "sign-in") nextSteps.push("Next: /bedrock login");
                else nextSteps.push("Next: ask your AWS administrator for bedrock:GetInferenceProfile");
            }
        }
        if (offline || health.aws.status !== "ready")
            rows.push(
                sources.models().length > 0
                    ? `${m.ok} Models: ${sources.models().length} loaded`
                    : `${m.skip} Models: not checked`,
            );
        const selected =
            ctx.model?.provider === "jig-bedrock"
                ? sources.models().find((model) => model.id === ctx.model?.id)
                : undefined;
        if (selected) rows.push(`${m.ok} Selected model: ${clean(selected.id)} · ${route(selected, config)} route`);
        else if (ctx.model?.provider === undefined || ctx.model.provider === "unknown")
            rows.push(`${m.skip} Selected model: none chosen`);
        else rows.push(`${m.skip} Selected model: not a jig-bedrock model`);
        const spendStatus = spend.commandStatus();
        rows.push(
            `${config.spendCommand === undefined ? m.skip : spendStatus.startsWith("ok") ? m.ok : m.fail} Spend command: ${spendStatus}`,
        );
        if (config.spendCommand !== undefined && !spendStatus.startsWith("ok"))
            nextSteps.push("Next: see docs/spend-command.md");
        if (debugEnabled(env, config))
            rows.push(`${m.skip} Debug log: ${debugLogPath(env)} (takes effect after restart)`);
        let requestOk = false;
        let requestError = "";
        if (call) {
            if (!sources.doctorCall) rows.push(`${m.fail} Request: not available in this install`);
            else {
                try {
                    const result = await sources.doctorCall(ctx.signal ?? new AbortController().signal);
                    requestOk = true;
                    rows.push(
                        `${m.ok} Request: ${result.route} route · ${(result.ms / 1000).toFixed(1)} s · cache read ${result.cacheRead}, wrote ${result.cacheWrite}`,
                    );
                } catch (error) {
                    requestError = error instanceof Error ? error.message : String(error);
                    rows.push(`${m.fail} Request: ${requestError}`);
                    // A credential failure is fixed outside this command: repeating the call cannot help.
                    const credentials = /AWS credentials .*could not be loaded/i.test(requestError);
                    nextSteps.push(
                        /data retention mode .* is not available for this model/i.test(requestError)
                            ? 'Next: this model needs an AWS account data-retention setting; choose another model with /model (or --model), then /bedrock doctor call. See docs/troubleshooting.md "A Fable model is refused".'
                            : credentials
                              ? profile === undefined
                                  ? 'Next: check the AWS keys or role with "aws sts get-caller-identity", or refresh the keys, then /bedrock doctor call.'
                                  : `Next: check the keys or role for ${profile} with "aws sts get-caller-identity --profile ${profile}", or refresh the keys, then /bedrock doctor call.`
                              : "Next: fix the request failure above, then /bedrock doctor call",
                    );
                }
            }
        }
        const problems = rows.filter((row) => row.startsWith(m.fail)).length;
        const warningRows = rows.filter((row) => row.startsWith(m.warn)).length;
        const next =
            nextSteps[0] ??
            (warningRows > 0
                ? "Next: check the region or tag in /bedrock settings, then /bedrock refresh."
                : "Next: /bedrock doctor");
        if (problems === 0 && warningRows === 0)
            rows.push(
                call && requestOk
                    ? "Bedrock is ready."
                    : "Setup looks right; no request was sent. /bedrock doctor call sends one.",
            );
        else if (problems > 0) rows.push(`${problems} problem${problems === 1 ? "" : "s"}.`);
        else rows.push(`${warningRows} warning${warningRows === 1 ? "" : "s"}.`);
        if (problems > 0 || warningRows > 0) rows.push(next);
        emit(ctx, "Bedrock doctor", rows);
    };
    const use = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const name = args.trim();
        if (name.split(/\s+/).length > 1) {
            emit(ctx, "Bedrock presets", [`${m.fail} Usage: /bedrock ${usageFor("use")}`]);
            return;
        }
        if (name === "" && ctx.mode === "tui" && ctx.hasUI && !toStdout(ctx)) {
            await presetsMenu(ctx);
            return;
        }
        if (name === "") {
            const list = sources.presetList?.() ?? [];
            if (list.length === 0) {
                emit(ctx, "Bedrock presets", [`${m.skip} No presets. Add one with /bedrock preset add <name>.`]);
                return;
            }
            emit(ctx, "Bedrock presets", [
                ...list.map((entry) => {
                    const active = entry.active ? " · active" : "";
                    const source = entry.active && entry.source !== undefined ? ` (${entry.source})` : "";
                    return `${entry.active ? m.ok : m.skip} ${entry.name} · ${entry.profile ?? "no AWS profile"} · ${entry.mode ?? "AWS-defined"}${active}${source}`;
                }),
                "Next: /bedrock use <name>",
            ]);
            return;
        }
        if (!sources.usePreset) {
            emit(ctx, "Bedrock presets", [`${m.fail} This install cannot switch presets.`]);
            return;
        }
        await sources.usePreset(name, ctx);
    };
    const preset = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const [action = "", name = ""] = args.trim().split(/\s+/);
        if (action === "add") {
            if (name === "" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
                emit(ctx, "Bedrock presets", [`${m.fail} Usage: /bedrock ${usageFor("preset")}`]);
                return;
            }
            if (!sources.presetAdd) {
                emit(ctx, "Bedrock presets", [`${m.fail} This install cannot add presets.`]);
                return;
            }
            await sources.presetAdd(name, ctx);
            return;
        }
        if (action === "remove") {
            if (name === "") {
                emit(ctx, "Bedrock presets", [`${m.fail} Usage: /bedrock ${usageFor("preset")}`]);
                return;
            }
            if (!sources.presetRemove) {
                emit(ctx, "Bedrock presets", [`${m.fail} This install cannot remove presets.`]);
                return;
            }
            await sources.presetRemove(name, ctx);
            return;
        }
        emit(ctx, "Bedrock presets", [`${m.fail} Usage: /bedrock ${usageFor("preset")}`]);
    };
    const help = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const wanted = args.trim();
        if (wanted === "") {
            emit(
                ctx,
                "Bedrock commands",
                BEDROCK_COMMANDS.map((command) => `${command.name.padEnd(10)} ${command.summary}`),
            );
            return;
        }
        const command = BEDROCK_COMMANDS.find((entry) => entry.name === wanted);
        if (command === undefined) {
            const near = closest(wanted);
            emit(ctx, "Bedrock commands", [
                `${m.fail} Unknown command ${clean(wanted, 40)}.${near ? ` Did you mean ${near}?` : ""}`,
                `Usage: /bedrock help [name]`,
            ]);
            return;
        }
        emit(ctx, "Bedrock commands", [`Usage: /bedrock ${command.usage}`, command.summary]);
    };
    const names = BEDROCK_SUBCOMMANDS;
    const closest = (value: string, choices: readonly string[] = names): string | undefined => {
        let best: string | undefined;
        let distance = Infinity;
        for (const name of choices) {
            const a = value;
            const b = name;
            const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
            for (let j = 1; j <= b.length; j++) {
                let row = dp[0];
                if (row === undefined) {
                    row = [];
                    dp[0] = row;
                }
                row[j] = j;
            }
            for (let i = 1; i <= a.length; i++)
                for (let j = 1; j <= b.length; j++) {
                    let current = dp[i];
                    if (current === undefined) {
                        current = [];
                        dp[i] = current;
                    }
                    current[j] = Math.min(
                        (dp[i - 1]?.[j] ?? 0) + 1,
                        (dp[i]?.[j - 1] ?? 0) + 1,
                        (dp[i - 1]?.[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
                    );
                }
            const score = dp[a.length]?.[b.length] ?? Infinity;
            if (score < distance) {
                distance = score;
                best = name;
            }
        }
        return distance <= 2 ? best : undefined;
    };
    // A sub-menu that ends on Back returns true, so this menu shows again; Escape (undefined) or a finished action
    // closes the whole menu.
    const menu = async (ctx: ExtensionCommandContext): Promise<void> => {
        const actions: Array<{ label: string; run: () => unknown }> = [
            { label: "Status — profile, models, spend", run: () => status(ctx) },
            { label: "Check setup — doctor", run: () => doctor("", ctx) },
            { label: "Test one request — doctor call", run: () => doctor("call", ctx) },
            { label: "Models — routes and prices", run: () => modelsMenu(ctx) },
            { label: "Refresh models", run: () => refresh("", ctx) },
            { label: "Sign in again", run: () => login(ctx) },
            { label: "Presets", run: () => presetsMenu(ctx) },
            { label: "Settings", run: () => settingsMenu(ctx) },
            { label: "Spend", run: () => spendMenu(ctx) },
            { label: "Budget", run: () => budgetMenu(ctx) },
            { label: "Help", run: () => help("", ctx) },
        ];
        for (;;) {
            const choice = await ctx.ui.select(
                "Bedrock",
                actions.map((action) => action.label),
            );
            if (choice === undefined) return;
            const action = actions.find((entry) => entry.label === choice);
            if (action === undefined) return;
            if ((await action.run()) !== true) return;
        }
    };
    const presetsMenu = async (ctx: ExtensionCommandContext): Promise<boolean> => {
        const list = sources.presetList?.() ?? [];
        const actions = new Map<string, () => unknown>();
        for (const entry of list) {
            const active = entry.active ? `${m.ok} ` : "";
            const why = entry.active ? ` · active (${entry.source ?? "saved"})` : "";
            actions.set(
                `${active}${entry.name} — ${entry.profile ?? "no AWS profile"} · ${entry.mode ?? "AWS-defined"}${why}`,
                () => sources.usePreset?.(entry.name, ctx),
            );
        }
        actions.set("Save current settings as a preset…", async () => {
            const name = await ctx.ui.input(
                `Preset name · now: ${sources.activePreset?.().name ?? "none"} · e.g. work · empty cancels`,
                "work",
            );
            if (name === undefined) return false;
            if (name === "" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
                emit(ctx, "Bedrock presets", [
                    `${m.fail} ${clean(name, 40)} is not a preset name: a letter or digit, then up to 39 letters, digits, dots, underscores or hyphens`,
                ]);
                return false;
            }
            await sources.presetAdd?.(name, ctx);
            return false;
        });
        if (list.length > 0)
            actions.set("Remove a preset…", async () => {
                // The rows carry " — remove", so a preset named Back, or one like another action, is still removable.
                const choices = list.map((entry) => `${entry.name} — remove`);
                const selected = await ctx.ui.select("Remove preset", [...choices, "Back"]);
                if (selected === undefined) return false;
                if (selected === "Back") return true;
                const name = list[choices.indexOf(selected)]?.name;
                if (name === undefined) return false;
                const confirmed = await ctx.ui.confirm("Remove preset", `Remove ${name}?`);
                if (!confirmed) return false;
                await sources.presetRemove?.(name, ctx);
                return false;
            });
        const title =
            list.length === 0
                ? "Bedrock presets · No presets yet. Save the current settings as one first."
                : "Bedrock presets";
        for (;;) {
            const choice = await ctx.ui.select(title, [...actions.keys(), "Back"]);
            if (choice === undefined) return false;
            if (choice === "Back") return true;
            if ((await actions.get(choice)?.()) !== true) return false;
        }
    };
    const settingsMenu = async (ctx: ExtensionCommandContext): Promise<boolean> => {
        const doc = readSettingsDocument(env);
        const values = config as unknown as Record<string, unknown>;
        const envNames: Record<string, string> = {
            tagKey: "JIG_BEDROCK_TAG_KEY",
            tagValue: "JIG_BEDROCK_TAG_VALUE",
            profile: "JIG_BEDROCK_PROFILE",
            regions: "JIG_BEDROCK_REGIONS",
            debug: "JIG_BEDROCK_DEBUG",
        };
        const sourceOf = (key: string): string => {
            if (key === "preset") return config.presetSource === "env" ? "JIG_BEDROCK_PRESET variable" : "bedrock.json";
            if (envNames[key] !== undefined && env[envNames[key] as string] !== undefined)
                return `${envNames[key]} variable`;
            if (!("error" in doc) && Object.hasOwn(doc.target, key)) return "bedrock.json";
            if (Object.hasOwn(DEFAULTS as Record<string, unknown>, key)) return "default";
            return "";
        };
        const labels: Array<{ key: string; label: string }> = [];
        for (const key of FIELDS.filter((key) => key !== "presets")) {
            if (key === "tagValue" || key === "activeTagValue") continue;
            const pair = key === "tagKey" ? "tagValue" : key === "activeTagKey" ? "activeTagValue" : undefined;
            if (pair !== undefined) {
                const name = key === "tagKey" ? "Tag" : "Second tag";
                const left = values[key];
                const right = values[pair];
                if (left === undefined && right === undefined) labels.push({ key, label: `${name}: not set` });
                else
                    labels.push({
                        key,
                        label: `${name}: ${String(left ?? "?")} = ${String(right ?? "?")} (${sourceOf(key)})`,
                    });
                continue;
            }
            const value =
                key === "preset" ? config.preset : (values[key] ?? (DEFAULTS as Record<string, unknown>)[key]);
            if (value === undefined || (Array.isArray(value) && value.length === 0)) {
                labels.push({ key, label: `${key}: not set` });
                continue;
            }
            const shown = Array.isArray(value) ? value.join(",") : String(value);
            labels.push({ key, label: `${key}: ${shown} (${sourceOf(key)})` });
        }
        for (;;) {
            const choice = await ctx.ui.select("Bedrock settings", [...labels.map((entry) => entry.label), "Back"]);
            if (choice === undefined) return false;
            if (choice === "Back") return true;
            const key = labels.find((entry) => entry.label === choice)?.key;
            if (key === undefined) return false;
            const pair = key === "tagKey" ? "tagValue" : key === "activeTagKey" ? "activeTagValue" : undefined;
            const current =
                key === "preset" ? config.preset : (values[key] ?? (DEFAULTS as Record<string, unknown>)[key]);
            for (;;) {
                const action = await ctx.ui.select(
                    `${key} (current: ${Array.isArray(current) ? current.join(",") : (current ?? "unset")})`,
                    ["Set", "Unset", "Back"],
                );
                if (action === undefined) return false;
                if (action === "Back") break;
                if (action === "Unset") {
                    await unset(pair === undefined ? key : `${key} ${pair}`, ctx, true);
                    return false;
                }
                if (key === "api") {
                    const answer = await ctx.ui.select("api (example: messages)", ["messages", "converse"]);
                    if (answer !== undefined) await set(`api ${answer}`, ctx, true);
                    return false;
                }
                if (key === "discovery") {
                    const answer = await ctx.ui.select(`discovery (current: ${String(current ?? "unset")})`, [
                        "aws-defined",
                        "tag",
                        "list",
                    ]);
                    if (answer !== undefined) await set(`discovery ${answer}`, ctx, true);
                    return false;
                }
                if (key === "signInAtStart" || key === "debug") {
                    const answer = await ctx.ui.select(`${key} (current: ${String(current ?? "unset")})`, [
                        "on",
                        "off",
                    ]);
                    if (answer !== undefined) await set(`${key} ${answer === "on" ? "true" : "false"}`, ctx, true);
                    return false;
                }
                if (pair !== undefined) {
                    const answer = await ctx.ui.input(
                        `${key === "tagKey" ? "Tag" : "Second tag"} · now: ${String(current ?? "not set")} · e.g. Team my-team · empty cancels`,
                        "Team my-team",
                    );
                    const [left, right] = (answer ?? "").trim().split(/\s+/);
                    if (left !== undefined && right !== undefined) {
                        await set(`${key} ${left} ${pair} ${right}`, ctx, true);
                    }
                    return false;
                }
                const examples = SETTING_EXAMPLES;
                const format =
                    key === "regions"
                        ? "comma separated, e.g. us-east-1,us-west-2"
                        : `e.g. ${examples[key] ?? "value"}`;
                let answer = await ctx.ui.input(
                    `${key}: ${format} · now: ${Array.isArray(current) ? current.join(",") : (current ?? "not set")} · empty keeps it · Unset removes it`,
                    current === undefined
                        ? (examples[key] ?? "value")
                        : Array.isArray(current)
                          ? current.join(",")
                          : String(current),
                );
                while (answer !== undefined && answer !== "") {
                    if (await set(`${key} ${answer}`, ctx, true)) return false;
                    answer = await ctx.ui.input(
                        `${key}: value not accepted · ${format} · Escape leaves it unchanged`,
                        String(answer),
                    );
                }
                return false;
            }
        }
    };
    const modelsMenu = async (ctx: ExtensionCommandContext): Promise<boolean> => {
        const list = sources.models();
        const rejected = sources.unavailable?.() ?? [];
        const refused = sources.refused?.() ?? [];
        const priceOf = (model: BedrockModel): string =>
            model.rateSource === "no price" ? "price unknown" : `$${model.cost.input}/$${model.cost.output}`;
        const actions = new Map<string, () => unknown>();
        for (const model of list)
            actions.set(`${model.id} — ${route(model, config)} · ${priceOf(model)}`, () => {
                const region =
                    /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/.exec(model.baseUrl)?.[1] ??
                    model.arn.split(":")[3] ??
                    "";
                const details = [
                    `${model.id}`,
                    `${route(model, config)} route · ${routeReason(model, config)}`,
                    `Region: ${region}`,
                    `Price per million tokens: ${
                        model.rateSource === "no price"
                            ? "price unknown (Pi lists no price for this model)"
                            : `$${model.cost.input} in / $${model.cost.output} out`
                    }`,
                    `Inference profile: ${model.arn.slice(model.arn.lastIndexOf("/") + 1)}`,
                    ctx.model?.provider === "jig-bedrock" && ctx.model.id === model.id
                        ? "This is the session's model."
                        : "Not the session's model.",
                    "To keep it for every start: /model, select it, Ctrl+S.",
                ].join("\n");
                return ctx.ui.select(details, ["Use for this session", "Back"]).then(async (action) => {
                    if (action === undefined) return false;
                    if (action === "Back") return true;
                    const target = ctx.modelRegistry.find("jig-bedrock", model.id);
                    if (target === undefined) {
                        emit(ctx, "Bedrock models", [
                            `${m.fail} Pi has no entry for ${clean(model.id, 60)}; run /bedrock refresh, then try again.`,
                        ]);
                        return false;
                    }
                    const switched = await pi.setModel(target);
                    emit(ctx, "Bedrock models", [
                        switched === false
                            ? `${m.fail} Pi did not switch to ${clean(model.id, 60)}; it may have left /model. Run /bedrock refresh, then choose it with /model.`
                            : `${m.ok} Using ${clean(model.id, 60)} for this session.`,
                    ]);
                    return false;
                });
            });
        if (rejected.length > 0) {
            actions.set("Not loaded by this Pi", () => false);
            for (const entry of rejected)
                actions.set(
                    `${clean(entry.profile, 60)} · ${clean(entry.region, 20)} — ${clean(entry.reason.split(";")[0] ?? entry.reason, 70)}`,
                    async () => {
                        const action = await ctx.ui.select(`${entry.profile} · ${entry.region}\n${entry.reason}`, [
                            "Back",
                        ]);
                        if (action === undefined) return false;
                        return true;
                    },
                );
        }
        if (refused.length > 0) {
            actions.set("Refused by AWS for your role", () => false);
            for (const entry of refused)
                actions.set(`${entry.id} · ${entry.date.slice(0, 10)}`, async () => {
                    const action = await ctx.ui.select(
                        `${entry.id}\nRefused ${entry.date.slice(0, 10)} by AWS for this role.`,
                        ["Try again", "Back"],
                    );
                    if (action === undefined) return false;
                    if (action === "Back") return true;
                    await refresh("", ctx);
                    return false;
                });
        }
        if (actions.size === 0) {
            emit(ctx, "Bedrock models", [`${m.warn} No models loaded.`]);
            return false;
        }
        for (;;) {
            const choice = await ctx.ui.select("Bedrock models", [...actions.keys(), "Back"]);
            if (choice === undefined) return false;
            if (choice === "Back") return true;
            if ((await actions.get(choice)?.()) !== true) return false;
        }
    };
    const spendMenu = async (ctx: ExtensionCommandContext): Promise<boolean> => {
        const period = await ctx.ui.select("Spend period", ["Month", "Week", "Day", "Back"]);
        if (period === undefined) return false;
        if (period === "Back") return true;
        await usage(period.toLowerCase(), ctx);
        return false;
    };
    const budgetMenu = async (ctx: ExtensionCommandContext): Promise<boolean> => {
        const answer = await ctx.ui.input(
            `Monthly budget in USD · now: ${config.monthlyBudgetUsd === undefined ? "none" : `$${config.monthlyBudgetUsd}`} · e.g. 200 · 0 or off clears · empty keeps it`,
            config.monthlyBudgetUsd === undefined ? "200" : String(config.monthlyBudgetUsd),
        );
        if (answer === undefined || answer === "") return false;
        if (answer === "0" || answer === "off") await budget("off", ctx);
        else await budget(answer, ctx);
        return false;
    };
    const full: BedrockCommand = async (args, ctx) => {
        const [command = "", ...rest] = args.trim().split(/\s+/);
        const tail = rest.join(" ");
        switch (command) {
            case "":
                if (ctx.mode === "tui" && ctx.hasUI && !toStdout(ctx) && tail === "") {
                    await menu(ctx);
                    return;
                }
                await status(ctx);
                return;
            case "status":
                if (tail !== "") {
                    emit(ctx, "Bedrock", [`Usage: /bedrock ${usageFor("status")}`]);
                    return;
                }
                await status(ctx);
                return;
            case "doctor":
                await doctor(tail, ctx);
                return;
            case "models":
                await models(tail, ctx);
                return;
            case "refresh":
                await refresh(tail, ctx);
                return;
            case "login":
                if (tail !== "") {
                    emit(ctx, "Bedrock", [`Usage: /bedrock ${usageFor("login")}`]);
                    return;
                }
                await login(ctx);
                return;
            case "usage":
            case "spend":
                await usage(tail, ctx);
                return;
            case "budget":
                await budget(tail, ctx);
                return;
            case "settings":
                if (tail !== "") {
                    emit(ctx, "Bedrock", [`Usage: /bedrock ${usageFor("settings")}`]);
                    return;
                }
                await settings(ctx);
                return;
            case "set":
                await set(tail, ctx);
                return;
            case "unset":
                await unset(tail, ctx);
                return;
            case "use":
                await use(tail, ctx);
                return;
            case "preset":
                await preset(tail, ctx);
                return;
            case "migrate":
                if (tail !== "") {
                    emit(ctx, "Bedrock", [`Usage: /bedrock ${usageFor("migrate")}`]);
                    return;
                }
                if (sources.migrate) await sources.migrate("migrate", ctx);
                else emit(ctx, "Bedrock", [`${m.warn} No 0.2.x settings to migrate.`]);
                return;
            case "help":
                await help(tail, ctx);
                return;
            default: {
                const near = closest(command);
                emit(ctx, "Bedrock commands", [
                    `${m.fail} Unknown command ${clean(command)}.${near ? ` Did you mean ${near}?` : ""}`,
                    "Next: /bedrock help",
                ]);
            }
        }
    };
    const completions = (prefix: string): Array<{ value: string; label: string }> => {
        const parts = prefix.split(/\s+/);
        if (parts.length <= 1)
            return names
                .filter((name) => name.startsWith(parts[0] ?? ""))
                .map((name) => ({ value: name, label: name }));
        if ((parts[0] === "set" || parts[0] === "unset") && parts.length === 2)
            return FIELDS.filter((key) => key.startsWith(parts[1] ?? "")).map((key) => ({
                value: `${parts[0]} ${key}`,
                label: key,
            }));
        if (parts[0] === "use" && parts.length === 2)
            return (sources.presetNames?.() ?? [])
                .filter((name) => name.startsWith(parts[1] ?? ""))
                .map((name) => ({ value: `use ${name}`, label: name }));
        if (parts[0] === "preset" && parts[1] === "remove" && parts.length === 3)
            return (sources.presetNames?.() ?? [])
                .filter((name) => name.startsWith(parts[2] ?? ""))
                .map((name) => ({ value: `preset remove ${name}`, label: name }));
        return [];
    };
    return { bedrock: full, completions };
}

/** `/bedrock` still exists with broken settings: status, doctor, settings, set and unset can repair it without a reload. */
export function registerBrokenCommands(
    _pi: ExtensionAPI,
    options: {
        file: string;
        error: string;
        env: NodeJS.ProcessEnv;
        migrate?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    },
): BedrockCommand {
    const m = markers(options.env);
    const fallback: BedrockCommand = async (args, ctx) => {
        const [command = "", ...rest] = args.trim().split(/\s+/);
        const tail = rest.join(" ");
        const message = options.error.includes("not valid JSON")
            ? "Settings file is not valid JSON."
            : "Settings file is not valid.";
        const errorRows = [
            `${m.fail} ${message}`,
            ...(options.error.includes("not valid JSON") ? [] : [`${m.skip} ${clean(options.error, 80)}`]),
            `${m.skip} File: ${displayPath(options.file, options.env)}`,
            "Next: /bedrock set <key> <value>",
        ];
        switch (command) {
            case "":
            case "status":
                emit(ctx, "Bedrock · 1 problem", errorRows);
                return;
            case "doctor":
                emit(ctx, "Bedrock doctor", [
                    `${m.fail} ${message}`,
                    ...(options.error.includes("not valid JSON") ? [] : [`${m.skip} ${clean(options.error, 80)}`]),
                    `${m.skip} File: ${displayPath(options.file, options.env)}`,
                    `${m.skip} AWS not checked: broken settings`,
                    "1 problem.",
                    "Next: /bedrock set <key> <value>",
                ]);
                return;
            case "settings": {
                const doc = readSettingsDocument(options.env);
                if ("error" in doc) {
                    emit(ctx, "Bedrock settings", [
                        `${m.fail} Settings file is not valid JSON.`,
                        `${m.skip} File: ${displayPath(doc.file, options.env)}`,
                    ]);
                    return;
                }
                emit(ctx, "Bedrock settings", [
                    ...FIELDS.map(
                        (key) =>
                            `${m.ok} ${key} = ${clean(doc.target[key] === undefined ? "not set" : JSON.stringify(doc.target[key]), 64)}`,
                    ),
                    `${m.fail} The settings are not valid; fix one row at a time.`,
                ]);
                return;
            }
            case "set":
            case "unset": {
                if (command === "unset") {
                    const key = tail;
                    if (!(FIELDS as readonly string[]).includes(key)) {
                        emit(ctx, "Bedrock settings", [
                            key === ""
                                ? `${m.fail} Usage: /bedrock ${usageFor("unset")}`
                                : `${m.fail} Unknown setting ${clean(key, 60)}`,
                        ]);
                        return;
                    }
                    const doc = readSettingsDocument(options.env);
                    if ("error" in doc) {
                        emit(ctx, "Bedrock settings", [
                            `${m.fail} Settings file is not valid JSON.`,
                            `${m.skip} File: ${displayPath(doc.file, options.env)}`,
                        ]);
                        return;
                    }
                    delete doc.target[key];
                    const saved = writeSettingsDocument(options.env, doc.document);
                    emit(ctx, "Bedrock settings", [
                        saved.ok ? `${m.ok} ${key} unset.` : `${m.fail} ${saved.error}`,
                        ...(saved.ok ? [`${m.skip} Run /reload to use the repaired settings.`] : []),
                    ]);
                    return;
                }
                const pairs = parseSettingPairs(tail);
                if (pairs === undefined) {
                    emit(ctx, "Bedrock settings", [`${m.fail} Usage: /bedrock ${usageFor("set")}`]);
                    return;
                }
                for (const [key] of pairs) {
                    if (!(FIELDS as readonly string[]).includes(key)) {
                        emit(ctx, "Bedrock settings", [`${m.fail} Unknown setting ${clean(key, 60)}`]);
                        return;
                    }
                }
                const doc = readSettingsDocument(options.env);
                if ("error" in doc) {
                    emit(ctx, "Bedrock settings", [
                        `${m.fail} Settings file is not valid JSON.`,
                        `${m.skip} File: ${displayPath(doc.file, options.env)}`,
                    ]);
                    return;
                }
                for (const [key, value] of pairs) {
                    if ((key === "signInAtStart" || key === "debug") && !/^(true|false|on|off|yes|no)$/i.test(value)) {
                        emit(ctx, "Bedrock settings", [
                            `${m.fail} ${key} accepts true, false, on, off, yes or no; nothing was written.`,
                        ]);
                        return;
                    }
                    doc.target[key] = settingValue(key, value);
                }
                const candidate = loadConfig({ raw: doc.target, env: options.env });
                const saved = writeSettingsDocument(options.env, doc.document);
                emit(ctx, "Bedrock settings", [
                    saved.ok ? `${m.ok} ${pairs.map(([key]) => key).join(", ")} written.` : `${m.fail} ${saved.error}`,
                    ...(saved.ok && !candidate.config ? [`${m.fail} Still invalid: ${candidate.error}`] : []),
                    ...(saved.ok ? [`${m.skip} Run /reload to use the repaired settings.`] : []),
                ]);
                return;
            }
            case "help":
                emit(
                    ctx,
                    "Bedrock commands",
                    BEDROCK_COMMANDS.map((command) => `${command.name.padEnd(10)} ${command.summary}`),
                );
                return;
            case "migrate":
                if (options.migrate) await options.migrate("migrate", ctx);
                else emit(ctx, "Bedrock", [`${m.warn} No 0.2.x settings to migrate.`]);
                return;
            default:
                emit(ctx, "Bedrock", [`${m.fail} Unknown command while the settings are broken.`, ...errorRows]);
        }
    };
    return fallback;
}
