// User-facing Bedrock commands. Part B adds `/bedrock usage` and `/bedrock budget`; /bedrock-usage and /bedrock-stats
// call the same code. Every block is a title, marker rows, at most one Next, and plain words; without a UI the same text
// goes to standard output.
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CatalogSource, Status } from "./aws-discovery.ts";
import type { BedrockModel, Catalog } from "./catalog.ts";
import { routeOf } from "./catalog.ts";
import { DEFAULTS, FIELDS, loadConfig, type ResolvedConfig } from "./config.ts";
import { debugEnabled, debugLogPath } from "./debug-log.ts";
import { checkLocalDependencies } from "./doctor.ts";
import { type Markers, markers } from "./markers.ts";
import {
    type ListProfiles,
    LOGIN_PATH,
    NO_PROFILE,
    type ProfileChoice,
    type ProfileResolver,
    sourceLabel,
} from "./profile.ts";
import { readSettingsDocument, saveBudgetSetting, writeSettingsDocument } from "./settings-write.ts";
import { formatMoney, monthLabel, type SpendTracker } from "./spend.ts";

export const BEDROCK_SUBCOMMANDS = [
    "status",
    "doctor",
    "models",
    "refresh",
    "login",
    "usage",
    "budget",
    "settings",
    "set",
    "unset",
    "migrate",
    "help",
] as const;
const HELP: Record<(typeof BEDROCK_SUBCOMMANDS)[number], string> = {
    status: "show the profile, models, spend and budget",
    doctor: 'check the set-up; "doctor call" sends one tiny request',
    models: "list the models, routes and prices",
    refresh: "read the models from AWS again",
    login: "renew the chosen AWS sign-in",
    usage: "show the month, week or day spend by model",
    budget: "show, set or remove the display budget",
    settings: "show every setting and its source",
    set: "change one setting in bedrock.json",
    unset: "remove one setting from bedrock.json",
    migrate: "copy a 0.2.x jig.json section once",
    help: "this list",
};
type Json = Record<string, unknown>;
const clean = (value: unknown, max = 100): string =>
    String(value ?? "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal and bidi controls from a line
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
        .slice(0, max);
const money = formatMoney;
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
function noticeLine(ctx: ExtensionCommandContext, text: string): void {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else process.stdout.write(`${text}\n`);
}
function emit(ctx: ExtensionCommandContext, title: string, rows: readonly string[]): void {
    const text = [title, ...rows].map((line) => clean(line)).join("\n");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else process.stdout.write(`${text}\n`);
}
function profileLine(choice: ProfileChoice, m: Markers): string {
    if (choice.ambient === true) return `${m.warn} AWS profile: none chosen; using the environment credential chain`;
    if (choice.profile === undefined) return `${m.fail} AWS profile: none chosen. Run /login, choose Amazon Bedrock.`;
    const source = sourceLabel(choice.source);
    if (choice.problem !== undefined) return `${m.fail} AWS profile: ${choice.profile} (${source}) — ${choice.problem}`;
    if (choice.exists === false)
        return `${m.fail} AWS profile: ${choice.profile} (${source}) — not in ~/.aws/config; /login`;
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
    refresh?: () => Promise<Status>;
    login?: () => Promise<void>;
    unavailable?: () => Array<{ profile: string; region: string; reason: string }>;
    apply?: () => void;
    lastChoice?: () => ProfileChoice;
    loading?: () => boolean;
    doctorAws?: (signal: AbortSignal) => Promise<Array<{ ok: boolean; text: string }>>;
    doctorCall?: (signal: AbortSignal) => Promise<{ route: string; ms: number; cacheRead: number; cacheWrite: number }>;
}
export type BedrockCommand = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

export function registerBedrockCommands(
    pi: ExtensionAPI,
    sources: BedrockCommandSources,
): { bedrock: BedrockCommand; completions: (prefix: string) => Array<{ value: string; label: string }> } {
    const { config, spend } = sources;
    const env = sources.env ?? process.env;

    const usage = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const period = usageText(args);
        if (period === undefined) {
            emit(ctx, "Bedrock spend", ["✗ Unknown period. Use day, week or month."]);
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
            ]);
            spend.updateFooter(ctx);
            return;
        }
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 1) {
            emit(ctx, "Bedrock budget", ["✗ The budget must be at least $1."]);
            return;
        }
        config.monthlyBudgetUsd = amount;
        const saved = saveBudgetSetting(env, amount);
        emit(ctx, "Bedrock budget", [
            saved.ok ? `✓ Budget set to ${money(amount)}.` : `✗ ${saved.error}`,
            "! Not an AWS limit; no request is blocked.",
        ]);
        spend.updateFooter(ctx);
    };
    const status = async (ctx: ExtensionCommandContext): Promise<void> => {
        const m = markers(env);
        const list = sources.models();
        const last = sources.lastChoice?.() ?? { profile: config.profile };
        const view = spend.local("month");
        const limit = config.monthlyBudgetUsd;
        const rows: string[] = [];
        let problems = 0;
        if (last.profile === undefined) {
            rows.push(`${m.fail} AWS profile: none chosen`);
            problems++;
        } else if (last.exists === false) {
            rows.push(`${m.fail} AWS profile: ${clean(last.profile)} is not in ~/.aws/config`);
            problems++;
        } else {
            rows.push(
                `${m.ok} AWS profile: ${clean(last.profile)} · ${last.exists === true ? "signed in" : "sign-in not known yet"}`,
            );
        }
        if (sources.loading?.()) rows.push(`${m.skip} Models: loading from AWS…`);
        else if (list.length === 0) rows.push(`${m.warn} Models: not loaded`);
        else rows.push(`${m.ok} Models: ${list.length} loaded`);
        const selected = ctx.model;
        if (selected?.provider === "jig-bedrock") {
            const model = list.find((entry) => entry.id === selected.id);
            if (model) rows.push(`${m.ok} Selected model: ${clean(model.id)} · ${route(model, config)} route`);
            else {
                rows.push(`${m.warn} Selected model: ${clean(selected.id)} is not in your model list`);
                problems++;
            }
        } else if (selected?.provider === undefined || selected.provider === "unknown") {
            rows.push(`${m.skip} Selected model: none chosen`);
        } else {
            rows.push(`${m.skip} Selected model: not a jig-bedrock model`);
        }
        const spendText = `${monthLabel?.(view.month) ?? view.month} ${money(view.spentUsd)}${limit === undefined ? "" : ` of ${money(limit)}`}`;
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
        if (args.trim() !== "") {
            emit(ctx, "Bedrock models", ["✗ Usage: /bedrock models"]);
            return;
        }
        const list = [...sources.models()].sort((a, b) => a.id.localeCompare(b.id));
        const m = markers(env);
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
        for (const entry of rejected.slice(0, 3))
            rows.push(`${m.skip} ${clean(entry.profile)} · ${clean(entry.region)} — this Pi does not know the model`);
        if (rejected.length > 3) rows.push(`${m.skip} ... and ${rejected.length - 3} more`);
        if (list.length === 0) rows.push(`${m.warn} No models loaded.`);
        emit(ctx, `Bedrock models · ${list.length} · price per million tokens, in / out`, rows);
    };
    const settings = async (ctx: ExtensionCommandContext): Promise<void> => {
        const doc = readSettingsDocument(env);
        if ("error" in doc) {
            emit(ctx, "Bedrock settings", [`${markers(env).fail} ${doc.error}`]);
            return;
        }
        const m = markers(env);
        const home = env.HOME;
        const shownPath = home && doc.file.startsWith(home) ? `~${doc.file.slice(home.length)}` : doc.file;
        const envNames: Record<string, string> = {
            tagKey: "JIG_BEDROCK_TAG_KEY",
            tagValue: "JIG_BEDROCK_TAG_VALUE",
            profile: "JIG_BEDROCK_PROFILE",
            regions: "JIG_BEDROCK_REGIONS",
            debug: "JIG_BEDROCK_DEBUG",
        };
        const defaults = DEFAULTS as Record<string, unknown>;
        const keys = FIELDS.filter((key) => key !== "team");
        const isSet = (key: string) =>
            envNames[key] !== undefined && env[envNames[key] as string] !== undefined
                ? "environment"
                : Object.hasOwn(doc.target, key)
                  ? "file"
                  : Object.hasOwn(defaults, key)
                    ? "default"
                    : undefined;
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
                    : `${source === "default" ? m.skip : m.ok} ${key}: ${clean(show(key, value ?? defaults[key]), 72)} (${source})`,
            );
        emit(ctx, "Bedrock settings", [`${m.skip} File: ${shownPath}`, ...rows]);
    };
    const parseSetting = (key: string, value: string): unknown => {
        if (key === "regions" || key === "profiles" || key === "spendCommand")
            return value
                .split(",")
                .map((part) => part.trim())
                .filter((part) => part !== "");
        if (key === "signInAtStart") return value === "true";
        if (key === "monthlyBudgetUsd") return Number(value);
        return value;
    };
    const set = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const match = /^(\S+)\s+(.+)$/.exec(args.trim());
        if (!match) {
            emit(ctx, "Bedrock settings", ["✗ Usage: /bedrock set <key> <value>"]);
            return;
        }
        const key = match[1] as string;
        const value = match[2] as string;
        if (!(FIELDS as readonly string[]).includes(key)) {
            emit(ctx, "Bedrock settings", [`✗ ${key} is not a setting.`]);
            return;
        }
        const doc = readSettingsDocument(env);
        if ("error" in doc) {
            emit(ctx, "Bedrock settings", [`✗ ${doc.error}`]);
            return;
        }
        const parsed = parseSetting(key, value);
        if (key === "monthlyBudgetUsd" && (typeof parsed !== "number" || parsed < 1)) {
            emit(ctx, "Bedrock settings", ["✗ The budget must be at least $1."]);
            return;
        }
        doc.target[key] = parsed;
        const candidate = loadConfig({ raw: doc.target, env });
        const saved = writeSettingsDocument(env, doc.document);
        if (!saved.ok) {
            emit(ctx, "Bedrock settings", [`✗ ${saved.error}`]);
            return;
        }
        if (candidate.config) {
            Object.assign(config, candidate.config);
            sources.apply?.();
            emit(ctx, "Bedrock settings", [`✓ ${key} set.`]);
        } else {
            emit(ctx, "Bedrock settings", [
                `! ${key} written, but the settings still have a problem: ${candidate.error}`,
                "Next: /bedrock settings",
            ]);
        }
    };
    const unset = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const key = args.trim();
        if (!(FIELDS as readonly string[]).includes(key)) {
            emit(ctx, "Bedrock settings", [
                `✗ ${key === "" ? "Usage: /bedrock unset <key>" : `${key} is not a setting.`}`,
            ]);
            return;
        }
        const doc = readSettingsDocument(env);
        if ("error" in doc) {
            emit(ctx, "Bedrock settings", [`✗ ${doc.error}`]);
            return;
        }
        delete doc.target[key];
        const candidate = loadConfig({ raw: doc.target, env });
        const saved = writeSettingsDocument(env, doc.document);
        if (!saved.ok) {
            emit(ctx, "Bedrock settings", [`✗ ${saved.error}`]);
            return;
        }
        if (candidate.config) {
            Object.assign(config, candidate.config);
            sources.apply?.();
            emit(ctx, "Bedrock settings", [`✓ ${key} unset.`]);
        } else {
            emit(ctx, "Bedrock settings", [
                `! ${key} removed, but the settings still have a problem: ${candidate.error}`,
                "Next: /bedrock settings",
            ]);
        }
    };
    const refresh = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (!sources.refresh) {
            emit(ctx, "Bedrock refresh", ["✗ No catalog refresh is available in this install."]);
            return;
        }
        const before = new Set(sources.models().map((model) => model.id));
        const selectedBefore = ctx.model?.provider === "jig-bedrock" ? ctx.model.id : undefined;
        emit(ctx, "Bedrock refresh", ["– Reading the models from AWS…"]);
        const status = await sources.refresh();
        const after = sources.models();
        const added = after.filter((model) => !before.has(model.id)).length;
        const removed = [...before].filter((id) => !after.some((model) => model.id === id)).length;
        if (status !== "ok") {
            emit(ctx, "Bedrock refresh", [`✗ Refresh failed: ${status}.`, "Next: /bedrock doctor"]);
            return;
        }
        const rows = [
            `✓ ${after.length} model${after.length === 1 ? "" : "s"} loaded (${added} new, ${removed} gone).`,
        ];
        if (selectedBefore !== undefined && !after.some((model) => model.id === selectedBefore))
            rows.push("Choose /model if your selection was removed.");
        emit(ctx, "Bedrock refresh", rows);
    };
    const login = async (ctx: ExtensionCommandContext): Promise<void> => {
        if (!sources.login) {
            emit(ctx, "Bedrock login", ["✗ No sign-in is available in this install."]);
            return;
        }
        try {
            await sources.login();
            emit(ctx, "Bedrock login", ["✓ Sign-in finished. Models will refresh in the background."]);
        } catch {
            const profile = config.profile ?? "my-profile";
            emit(ctx, "Bedrock login", [
                "✗ Sign-in did not finish.",
                `Next: run "aws sso login --profile ${profile}" in a terminal, then /bedrock refresh.`,
            ]);
        }
    };
    const doctor = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (words.some((word) => word !== "offline" && word !== "call")) {
            emit(ctx, "Bedrock doctor", ["✗ Usage: /bedrock doctor [offline|call]"]);
            return;
        }
        const offline = words.includes("offline");
        const call = words.includes("call");
        if (call) noticeLine(ctx, "This sends one tiny request (a fraction of a cent).");
        const health = await (sources.check ?? checkLocalDependencies)({
            signal: ctx.signal,
            env,
            timeout: 15_000,
        });
        const m = markers(env);
        const rows: string[] = [];
        const node =
            health.node.status === "ready"
                ? `${m.ok} Node ${health.node.version ?? "unknown"}`
                : `${m.fail} Node ${health.node.version ?? "unknown"} (needs 22.19 or later)`;
        rows.push(node);
        if (health.aws.status === "ready") rows.push(`${m.ok} AWS CLI ${health.aws.version ?? "unknown"}`);
        else if (health.aws.status === "old")
            rows.push(`${m.fail} AWS CLI ${health.aws.version ?? "unknown"} (needs v2)`);
        else if (health.aws.status === "missing") rows.push(`${m.fail} AWS CLI: not found. Install AWS CLI v2.`);
        else rows.push(`${m.skip} AWS CLI: could not check`);
        const doc = readSettingsDocument(env);
        const home = env.HOME;
        const file = "file" in doc ? doc.file : join(home ?? "", ".pi/agent/bedrock.json");
        rows.push(`${m.ok} Settings: ${home && file.startsWith(home) ? `~${file.slice(home.length)}` : file}`);
        const last = sources.lastChoice?.() ?? { profile: config.profile };
        const profile = last.profile ?? config.profile;
        if (profile === undefined) rows.push(`${m.fail} AWS profile: none chosen`);
        else if (last.exists === false) rows.push(`${m.fail} AWS profile: ${clean(profile)} is not in ~/.aws/config.`);
        else {
            const source =
                last.source === "env"
                    ? "from JIG_BEDROCK_PROFILE"
                    : last.source === "login"
                      ? "from /login"
                      : last.source === "setting"
                        ? "from bedrock.json"
                        : "";
            rows.push(`${m.ok} AWS profile: ${clean(profile)}${source ? ` (${source})` : ""}`);
        }
        let awsRows: Array<{ ok: boolean; text: string }> = [];
        if (offline) rows.push(`${m.skip} AWS not checked: offline`);
        else if (sources.doctorAws) awsRows = await sources.doctorAws(ctx.signal ?? new AbortController().signal);
        for (const check of awsRows) {
            const text = check.text
                .replace(/^AWS identity: /, "Sign-in: ")
                .replace(/^Inference profiles: /, "Models: ")
                .replace(/^One profile: /, "One inference profile: ");
            rows.push(`${check.ok ? m.ok : m.fail} ${text}`);
        }
        if (!offline && awsRows.length === 0) rows.push(`${m.skip} AWS checks: not run`);
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
        if (debugEnabled(env, config)) rows.push(`${m.skip} Debug log: ${debugLogPath(env)}`);
        if (call) {
            if (!sources.doctorCall) rows.push(`${m.skip} Request: not available in this install`);
            else {
                try {
                    const result = await sources.doctorCall(ctx.signal ?? new AbortController().signal);
                    rows.push(
                        `${m.ok} Request: ${result.route} route · ${(result.ms / 1000).toFixed(1)} s · cache read ${result.cacheRead}, wrote ${result.cacheWrite}`,
                    );
                } catch (error) {
                    rows.push(`${m.fail} Request: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        const problems = rows.filter((row) => row.startsWith(m.fail)).length;
        const next = (() => {
            const failed = rows.find((row) => row.startsWith(m.fail)) ?? "";
            if (failed.includes("Node")) return "Next: upgrade Node to 22.19 or later";
            if (failed.includes("AWS CLI")) return "Next: install AWS CLI v2";
            if (failed.includes("AWS profile")) return "Next: /login, choose Amazon Bedrock (jig-bedrock)";
            if (failed.includes("Sign-in")) return "Next: /bedrock login";
            if (failed.includes("inference profile:"))
                return "Next: ask your AWS administrator for bedrock:GetInferenceProfile";
            if (failed.includes("Models"))
                return "Next: /bedrock refresh; ask your AWS administrator for bedrock:ListInferenceProfiles";
            if (failed.includes("Spend command")) return "Next: see docs/spend-command.md";
            if (failed.includes("Request")) return "Next: /bedrock doctor";
            return "Next: /bedrock doctor";
        })();
        rows.push(problems === 0 ? "Bedrock is ready." : `${problems} problem${problems === 1 ? "" : "s"}.`);
        if (problems > 0) rows.push(next);
        emit(ctx, "Bedrock doctor", rows);
    };
    const help = async (ctx: ExtensionCommandContext): Promise<void> => {
        emit(
            ctx,
            "Bedrock commands",
            BEDROCK_SUBCOMMANDS.map((name) => `${name.padEnd(10)} ${HELP[name]}`),
        );
    };
    const names = [
        "status",
        "doctor",
        "models",
        "refresh",
        "login",
        "usage",
        "budget",
        "settings",
        "set",
        "unset",
        "migrate",
        "help",
    ];
    const closest = (value: string): string | undefined => {
        let best: string | undefined;
        let distance = Infinity;
        for (const name of names) {
            const a = value;
            const b = name;
            const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
            for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
            for (let i = 1; i <= a.length; i++)
                for (let j = 1; j <= b.length; j++)
                    dp[i]![j] = Math.min(
                        dp[i - 1]![j]! + 1,
                        dp[i]![j - 1]! + 1,
                        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
                    );
            if (dp[a.length]![b.length]! < distance) {
                distance = dp[a.length]![b.length]!;
                best = name;
            }
        }
        return distance <= 2 ? best : undefined;
    };
    const full: BedrockCommand = async (args, ctx) => {
        const [command = "", ...rest] = args.trim().split(/\s+/);
        const tail = rest.join(" ");
        switch (command) {
            case "":
            case "status":
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
                await login(ctx);
                return;
            case "usage":
                await usage(tail, ctx);
                return;
            case "budget":
                await budget(tail, ctx);
                return;
            case "settings":
                await settings(ctx);
                return;
            case "set":
                await set(tail, ctx);
                return;
            case "unset":
                await unset(tail, ctx);
                return;
            case "migrate":
                if (sources.migrate) await sources.migrate("migrate", ctx);
                else emit(ctx, "Bedrock", ["! No 0.2.x settings to migrate."]);
                return;
            case "help":
                await help(ctx);
                return;
            default: {
                const near = closest(command);
                await help(ctx);
                emit(ctx, "Bedrock commands", [
                    `✗ Unknown command ${clean(command)}.${near ? ` Did you mean ${near}?` : ""}`,
                    ...BEDROCK_SUBCOMMANDS.map((name) => `${name.padEnd(10)} ${HELP[name]}`),
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
        if (parts[0] === "set" && parts.length === 2)
            return FIELDS.filter((key) => key.startsWith(parts[1] ?? "")).map((key) => ({ value: key, label: key }));
        return [];
    };
    const legacy =
        (mapped: BedrockCommand, oldName: string): BedrockCommand =>
        async (args, ctx) => {
            const line = `This name goes away in the next release: use /bedrock ${oldName}.`;
            if (ctx.hasUI) {
                const proxy = {
                    ...ctx,
                    ui: {
                        ...ctx.ui,
                        notify: (text: string, type: "info" | "warning" | "error") =>
                            ctx.ui.notify(`${text}\n${line}`, type),
                    },
                } as ExtensionCommandContext;
                await mapped(args, proxy);
            } else {
                await mapped(args, ctx);
                process.stdout.write(`${line}\n`);
            }
        };
    pi.registerCommand("bedrock-usage", {
        description: "Old name for /bedrock usage",
        handler: legacy((args, ctx) => usage(args, ctx), "usage"),
    });
    pi.registerCommand("bedrock-stats", {
        description: "Old name for /bedrock usage",
        handler: legacy((args, ctx) => usage(args, ctx), "usage"),
    });
    pi.registerCommand("bedrock-profiles", {
        description: "Old name for /bedrock models",
        handler: legacy((args, ctx) => models(args, ctx), "models"),
    });
    pi.registerCommand("bedrock-doctor", {
        description: "Old name for /bedrock doctor",
        handler: legacy((args, ctx) => doctor(args, ctx), "doctor"),
    });
    pi.registerCommand("bedrock-refresh", {
        description: "Old name for /bedrock refresh",
        handler: legacy((args, ctx) => refresh(args, ctx), "refresh"),
    });
    return { bedrock: full, completions };
}

/** `/bedrock` still exists with broken settings: status, doctor, settings, set and unset can repair it without a reload. */
export function registerBrokenCommands(
    pi: ExtensionAPI,
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
        const errorRows = [
            `${m.fail} ${options.error}`,
            `${m.skip} File: ${options.file}`,
            "Next: /bedrock set <key> <value>",
        ];
        switch (command) {
            case "":
            case "status":
                emit(ctx, "Bedrock · status: 1 problem", errorRows);
                return;
            case "doctor":
                emit(ctx, "Bedrock · health: 1 problem", [
                    ...errorRows,
                    `${m.skip} AWS checks: skipped while the settings are broken`,
                ]);
                return;
            case "settings": {
                const doc = readSettingsDocument(options.env);
                if ("error" in doc) {
                    emit(ctx, "Bedrock settings", [`${m.fail} ${doc.error}`]);
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
                        emit(ctx, "Bedrock settings", [`${m.fail} ${key || "Usage: /bedrock unset <key>"}`]);
                        return;
                    }
                    const doc = readSettingsDocument(options.env);
                    if ("error" in doc) {
                        emit(ctx, "Bedrock settings", [`${m.fail} ${doc.error}`]);
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
                const match = /^(\S+)\s+(.+)$/.exec(tail);
                if (!match) {
                    emit(ctx, "Bedrock settings", [`${m.fail} Usage: /bedrock set <key> <value>`]);
                    return;
                }
                const key = match[1] as string;
                const value = match[2] as string;
                if (!(FIELDS as readonly string[]).includes(key)) {
                    emit(ctx, "Bedrock settings", [`${m.fail} ${key} is not a setting.`]);
                    return;
                }
                const doc = readSettingsDocument(options.env);
                if ("error" in doc) {
                    emit(ctx, "Bedrock settings", [`${m.fail} ${doc.error}`]);
                    return;
                }
                doc.target[key] =
                    key === "regions" || key === "profiles" || key === "spendCommand"
                        ? value
                              .split(",")
                              .map((part) => part.trim())
                              .filter(Boolean)
                        : key === "signInAtStart"
                          ? value === "true"
                          : key === "monthlyBudgetUsd"
                            ? Number(value)
                            : value;
                const candidate = loadConfig({ raw: doc.target, env: options.env });
                const saved = writeSettingsDocument(options.env, doc.document);
                const rows = saved.ok ? [`${m.ok} ${key} written.`] : [`${m.fail} ${saved.error}`];
                if (saved.ok && !candidate.config) rows.push(`${m.fail} Still invalid: ${candidate.error}`);
                if (saved.ok) rows.push(`${m.skip} Run /reload to use the repaired settings.`);
                emit(ctx, "Bedrock settings", rows);
                return;
            }
            case "help":
                emit(ctx, "Bedrock commands", [
                    "status · doctor [offline|call] · models · refresh · login",
                    "usage [day|week|month] · budget [amount|off]",
                    "settings · set <key> <value> · unset <key>",
                    "migrate · help",
                ]);
                return;
            case "migrate":
                if (options.migrate) await options.migrate("migrate", ctx);
                else emit(ctx, "Bedrock", ["! No 0.2.x settings to migrate."]);
                return;
            default:
                emit(ctx, "Bedrock", [`${m.fail} Unknown command while the settings are broken.`, ...errorRows]);
        }
    };
    const legacy =
        (mapped: BedrockCommand, name: string): BedrockCommand =>
        async (args, ctx) => {
            const line = `This name goes away in the next release: use /bedrock ${name}.`;
            if (ctx.hasUI) {
                const proxy = {
                    ...ctx,
                    ui: {
                        ...ctx.ui,
                        notify: (text: string, type: "info" | "warning" | "error") =>
                            ctx.ui.notify(`${text}\n${line}`, type),
                    },
                } as ExtensionCommandContext;
                await mapped(args, proxy);
            } else {
                await mapped(args, ctx);
                process.stdout.write(`${line}\n`);
            }
        };
    pi.registerCommand("bedrock-usage", {
        description: "Old name for /bedrock usage",
        handler: legacy((a, c) => fallback(`usage ${a}`, c), "usage"),
    });
    pi.registerCommand("bedrock-stats", {
        description: "Old name for /bedrock usage",
        handler: legacy((a, c) => fallback(`usage ${a}`, c), "usage"),
    });
    pi.registerCommand("bedrock-profiles", {
        description: "Old name for /bedrock models",
        handler: legacy((a, c) => fallback(`models ${a}`, c), "models"),
    });
    pi.registerCommand("bedrock-doctor", {
        description: "Old name for /bedrock doctor",
        handler: legacy((a, c) => fallback(`doctor ${a}`, c), "doctor"),
    });
    pi.registerCommand("bedrock-refresh", {
        description: "Old name for /bedrock refresh",
        handler: legacy((a, c) => fallback(`refresh ${a}`, c), "refresh"),
    });
    return fallback;
}
