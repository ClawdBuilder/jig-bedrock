// This package's own spend record: one JSONL line per Bedrock reply, monthly UTC files under XDG_STATE_HOME, a display
// budget, a footer line and an optional command the user names. No prompt, ARN, account id or profile is written here.
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BedrockModel } from "./catalog.ts";
import type { ResolvedConfig } from "./config.ts";
import { isOwnModel } from "./identity.ts";

type Json = Record<string, unknown>;
const tokens = (value: number): string => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    return String(value);
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export const monthOf = (time: number): string => new Date(time).toISOString().slice(0, 7);
export const monthLabel = (month: string): string =>
    `${MONTHS[Number(month.slice(5)) - 1] ?? month} ${month.slice(0, 4)}`;
export const formatMoney = (value: number): string =>
    value > 0 && value < 0.01 ? "<$0.01" : value < 10 ? `$${value.toFixed(2)}` : `$${Math.round(value)}`;
const money = formatMoney;
const tableMoney = (value: number): string => (value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`);
export const isPriced = (
    cost: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | undefined,
): boolean => !!cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some((value) => number(value) > 0);

export interface SpendReply {
    type: "reply";
    preset?: string;
    at: string;
    session: string;
    model: string;
    region: string;
    route: "messages" | "converse";
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    priced: boolean;
}
export interface SpendTotals {
    spentUsd: number;
    unpriced: boolean;
    replies: number;
}
export interface SpendModel extends SpendTotals {
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
export interface SpendView extends SpendTotals {
    month: string;
    local: SpendTotals;
    models: SpendModel[];
    presets?: Array<{ preset: string; spentUsd: number; unpriced: boolean; replies: number }>;
    command?: SpendTotals;
    commandError?: string;
}
export interface SpendCommandResult {
    month: string;
    spentUsd: number;
}

/** This package's folder under the user's state folder (`XDG_STATE_HOME`, else `~/.local/state`). */
export function stateFolder(env: NodeJS.ProcessEnv = process.env): string {
    const root = env.XDG_STATE_HOME || join(env.HOME ?? homedir(), ".local", "state");
    return join(root, "jig-bedrock");
}
export function spendFolder(env: NodeJS.ProcessEnv = process.env): string {
    return join(stateFolder(env), "spend");
}
function monthFile(env: NodeJS.ProcessEnv, month: string): string {
    return join(spendFolder(env), `${month}.jsonl`);
}
function ensureFolder(folder: string): void {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    try {
        chmodSync(folder, 0o700);
    } catch {}
}
function parseLine(line: string): Json | undefined {
    try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
    } catch {
        return undefined;
    }
}
function modelTotals(replies: readonly SpendReply[]): SpendModel[] {
    const rows = new Map<string, SpendReply[]>();
    for (const reply of replies) rows.set(reply.model, [...(rows.get(reply.model) ?? []), reply]);
    return [...rows.entries()]
        .map(([model, list]) => ({
            model,
            replies: list.length,
            input: list.reduce((n, reply) => n + reply.input, 0),
            output: list.reduce((n, reply) => n + reply.output, 0),
            cacheRead: list.reduce((n, reply) => n + reply.cacheRead, 0),
            cacheWrite: list.reduce((n, reply) => n + reply.cacheWrite, 0),
            spentUsd: list.reduce((n, reply) => n + (reply.priced ? reply.costUsd : 0), 0),
            unpriced: list.some((reply) => !reply.priced),
        }))
        .sort((a, b) => b.spentUsd - a.spentUsd || a.model.localeCompare(b.model));
}
function totals(replies: readonly SpendReply[]): SpendTotals {
    return {
        spentUsd: replies.reduce((sum, reply) => sum + (reply.priced ? reply.costUsd : 0), 0),
        unpriced: replies.some((reply) => !reply.priced),
        replies: replies.length,
    };
}
export function readMonth(env: NodeJS.ProcessEnv, month: string): SpendReply[] {
    let text: string;
    try {
        text = readFileSync(monthFile(env, month), "utf8");
    } catch {
        return [];
    }
    const replies: SpendReply[] = [];
    for (const line of text.split("\n")) {
        const value = parseLine(line);
        if (value?.type !== "reply" || value.month !== undefined) continue;
        if (
            typeof value.at !== "string" ||
            !value.at.startsWith(month) ||
            typeof value.session !== "string" ||
            typeof value.model !== "string" ||
            typeof value.region !== "string" ||
            (value.route !== "messages" && value.route !== "converse")
        )
            continue;
        replies.push({
            type: "reply",
            ...(typeof value.preset === "string" ? { preset: value.preset } : {}),
            at: value.at,
            session: value.session,
            model: value.model,
            region: value.region,
            route: value.route,
            input: number(value.input),
            output: number(value.output),
            cacheRead: number(value.cacheRead),
            cacheWrite: number(value.cacheWrite),
            costUsd: number(value.costUsd),
            priced: value.priced === true,
        });
    }
    return replies;
}
export function replyLine(reply: SpendReply): string {
    return JSON.stringify(reply);
}
/** One appendFile call, O_APPEND; a failed write is returned, never thrown into a reply. */
export function appendReply(env: NodeJS.ProcessEnv, reply: SpendReply): { ok: boolean; error?: string } {
    const folder = spendFolder(env);
    const file = monthFile(env, reply.at.slice(0, 7));
    try {
        ensureFolder(folder);
        appendFileSync(file, `${replyLine(reply)}\n`, { mode: 0o600 });
        chmodSync(file, 0o600);
        return { ok: true };
    } catch {
        return { ok: false, error: "Bedrock spend could not be saved; this reply is not in the local total." };
    }
}

/** Read older replies once, under 2,000 files and 10 seconds, and mark the import in the same file. */
export async function importEarlier(
    env: NodeJS.ProcessEnv,
    agentDir: string,
    month: string,
    now: number | (() => number) = Date.now,
    limits = { files: 2_000, ms: 10_000 },
    resolveModel?: (arn: string) => string | undefined,
): Promise<{ imported: number; failed?: string }> {
    const clock = typeof now === "function" ? now : () => now;
    const file = monthFile(env, month);
    await new Promise((resolve) => setImmediate(resolve));
    if (existsSync(file)) return { imported: 0 };
    const folder = spendFolder(env);
    const lock = join(folder, "import.lock");
    try {
        ensureFolder(folder);
        mkdirSync(lock);
    } catch {
        return { imported: 0 };
    }
    const deadline = clock() + limits.ms;
    const replies: SpendReply[] = [];
    let files = 0;
    const walk = (dir: string): void => {
        if (files >= limits.files || clock() > deadline) return;
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (files >= limits.files || clock() > deadline) return;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                files++;
                let text: string;
                try {
                    text = readFileSync(path, "utf8");
                } catch {
                    continue;
                }
                for (const line of text.split("\n")) {
                    const value = parseLine(line);
                    const message = value?.type === "message" ? (value.message as Json | undefined) : undefined;
                    if (
                        message?.role !== "assistant" ||
                        (message.provider !== "jig-bedrock" && message.provider !== "amazon-bedrock")
                    )
                        continue;
                    const at = typeof message.timestamp === "number" ? new Date(message.timestamp) : undefined;
                    if (!at || at.toISOString().slice(0, 7) !== month) continue;
                    const usage = message.usage as Json | undefined;
                    const costUsd = Number(number(usage?.cost && (usage.cost as Json).total).toFixed(8));
                    const recorded = typeof message.model === "string" ? message.model : "";
                    if (recorded === "") continue;
                    const model =
                        message.provider === "amazon-bedrock" && recorded.startsWith("arn:")
                            ? (resolveModel?.(recorded) ?? "earlier sessions")
                            : recorded;
                    replies.push({
                        type: "reply",
                        at: at.toISOString(),
                        session: typeof value?.id === "string" ? value.id : "imported",
                        model,
                        region: "",
                        route: message.api === "anthropic-messages" ? "messages" : "converse",
                        input: number(usage?.input),
                        output: number(usage?.output),
                        cacheRead: number(usage?.cacheRead),
                        cacheWrite: number(usage?.cacheWrite),
                        costUsd,
                        priced: costUsd > 0,
                    });
                }
            }
        }
    };
    try {
        walk(join(agentDir, "sessions"));
        if (replies.length > 0 || !existsSync(file)) {
            const lines = replies.map(replyLine);
            lines.push(JSON.stringify({ type: "import", at: new Date(clock()).toISOString(), month, files: files }));
            ensureFolder(folder);
            appendFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
            chmodSync(file, 0o600);
        }
        return { imported: replies.length };
    } catch {
        return { imported: 0, failed: "Earlier Pi sessions could not be read for this month's spend." };
    } finally {
        try {
            rmSync(lock, { recursive: true, force: true });
        } catch {}
    }
}

export function localView(
    env: NodeJS.ProcessEnv,
    month: string,
    period: "day" | "week" | "month",
    now = Date.now(),
    preset?: string | null,
): SpendView {
    const all = readMonth(env, month);
    const today = new Date(now).toISOString().slice(0, 10);
    const timed =
        period === "day"
            ? all.filter((reply) => reply.at.slice(0, 10) === today)
            : period === "week"
              ? all.filter((reply) => now - Date.parse(reply.at) <= 7 * 86_400_000)
              : all;
    const replies =
        preset === undefined || preset === null ? timed : timed.filter((reply) => (reply.preset ?? "") === preset);
    const groups = new Map<string, SpendReply[]>();
    for (const reply of timed) groups.set(reply.preset ?? "", [...(groups.get(reply.preset ?? "") ?? []), reply]);
    return {
        month,
        local: totals(replies),
        models: modelTotals(replies),
        presets: [...groups.entries()].map(([name, list]) => ({ preset: name, ...totals(list) })),
        ...totals(replies),
    };
}

export function runSpendCommand(
    config: ResolvedConfig,
    now: () => number = Date.now,
    options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<SpendCommandResult> {
    const argv = config.spendCommand;
    if (!argv || argv.length === 0) return Promise.reject(new Error("no spend command is set"));
    return new Promise((accept, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: SpendCommandResult): void => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else accept(value as SpendCommandResult);
        };
        const child = execFile(
            argv[0] as string,
            argv.slice(1),
            {
                timeout: 30_000,
                maxBuffer: 65_536,
                signal: options.signal,
                env: {
                    ...(options.env ?? process.env),
                    ...(config.profile === undefined ? {} : { AWS_PROFILE: config.profile }),
                    AWS_REGION: config.regions[0],
                    AWS_DEFAULT_REGION: config.regions[0],
                    NO_COLOR: "1",
                },
            },
            (error, stdout) => {
                if (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    const message = error.killed
                        ? "timed out"
                        : code === "ENOENT"
                          ? "not found"
                          : typeof code === "number" || /^\d+$/.test(String(code))
                            ? `exit code ${String(code)}`
                            : "failed";
                    finish(new Error(message));
                    return;
                }
                try {
                    const value = JSON.parse(String(stdout)) as Json;
                    if (
                        typeof value.month !== "string" ||
                        value.month !== monthOf(now()) ||
                        typeof value.spentUsd !== "number" ||
                        !Number.isFinite(value.spentUsd) ||
                        value.spentUsd < 0
                    )
                        throw new Error("bad result");
                    finish(undefined, { month: value.month, spentUsd: value.spentUsd });
                } catch {
                    finish(new Error("no valid month/spentUsd JSON"));
                }
            },
        );
        child.on("error", () => finish(new Error("the spend command could not start")));
    });
}

interface BudgetState {
    month: string;
    warned80: boolean;
    warned100: boolean;
}
function statePath(env: NodeJS.ProcessEnv): string {
    return join(spendFolder(env), "state.json");
}
function readState(env: NodeJS.ProcessEnv, month: string): BudgetState {
    try {
        const value = JSON.parse(readFileSync(statePath(env), "utf8")) as Partial<BudgetState>;
        if (value.month === month)
            return { month, warned80: value.warned80 === true, warned100: value.warned100 === true };
    } catch {}
    return { month, warned80: false, warned100: false };
}
function writeState(env: NodeJS.ProcessEnv, state: BudgetState): void {
    try {
        ensureFolder(spendFolder(env));
        const file = statePath(env);
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
        chmodSync(temporary, 0o600);
        // rename is atomic; a concurrent writer leaves a complete state, never a partial one.
        renameSync(temporary, file);
    } catch {}
}
/** Claim one threshold once per machine and month, with a lock folder so two Pi processes cannot both announce it. */
function claim(env: NodeJS.ProcessEnv, month: string, threshold: "warned80" | "warned100"): boolean {
    const folder = spendFolder(env);
    const lock = join(folder, "budget.lock");
    try {
        ensureFolder(folder);
        mkdirSync(lock);
    } catch {
        return false;
    }
    try {
        const state = readState(env, month);
        if (state[threshold]) return false;
        state[threshold] = true;
        writeState(env, state);
        return true;
    } finally {
        try {
            rmSync(lock, { recursive: true, force: true });
        } catch {}
    }
}

export class SpendTracker {
    readonly config: ResolvedConfig;
    readonly env: NodeJS.ProcessEnv;
    private readonly now: () => number;
    private readonly runner: typeof runSpendCommand;
    private command?: SpendCommandResult;
    private commandAt = -Infinity;
    private commandError?: string;
    private writeWarned = new Set<string>();
    private writeFailureNotified = new Set<string>();
    private imported = false;
    constructor(
        config: ResolvedConfig,
        env: NodeJS.ProcessEnv = process.env,
        now: () => number = Date.now,
        runner: typeof runSpendCommand = runSpendCommand,
    ) {
        this.config = config;
        this.env = env;
        this.now = now;
        this.runner = runner;
    }
    local(period: "day" | "week" | "month" = "month"): SpendView {
        return localView(this.env, monthOf(this.now()), period, this.now(), this.config.preset ?? "");
    }
    machine(period: "day" | "week" | "month" = "month"): SpendView {
        return localView(this.env, monthOf(this.now()), period, this.now(), null);
    }
    private withCommand(view: SpendView): SpendView {
        if (this.config.spendCommand === undefined) return view;
        if (this.command && this.command.month === monthOf(this.now())) {
            const command = { spentUsd: this.command.spentUsd, unpriced: false, replies: 0 };
            return { ...view, command, spentUsd: command.spentUsd, unpriced: false, commandError: this.commandError };
        }
        return { ...view, commandError: this.commandError };
    }
    async refresh(force = false): Promise<SpendView> {
        if (this.config.spendCommand !== undefined && (force || this.now() - this.commandAt >= 600_000)) {
            this.commandAt = this.now();
            try {
                this.command = await this.runner(this.config, this.now, { env: this.env });
                this.commandError = undefined;
            } catch (error) {
                this.commandError = error instanceof Error ? error.message : "the spend command failed";
                this.command = undefined;
            }
        }
        return this.withCommand(this.local());
    }
    async start(
        agentDir: string,
        context?: ExtensionContext,
        resolveModel?: (arn: string) => string | undefined,
    ): Promise<void> {
        if (!this.imported) {
            this.imported = true;
            const result = await importEarlier(
                this.env,
                agentDir,
                monthOf(this.now()),
                this.now,
                undefined,
                resolveModel,
            );
            if (result.failed && context?.hasUI) context.ui.notify(result.failed, "warning");
        }
        if (this.config.spendCommand !== undefined)
            void this.refresh(false).then(() => {
                if (context) {
                    this.updateFooter(context);
                    this.notice(context);
                }
            });
        if (context) this.updateFooter(context);
    }
    record(
        message: Json,
        session: string,
        model: BedrockModel | undefined,
    ): { reply?: SpendReply; error?: string } | undefined {
        if (message.role !== "assistant" || message.provider !== "jig-bedrock") return undefined;
        if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
        const usage = (message.usage ?? {}) as Json;
        const route = message.api === "anthropic-messages" ? "messages" : "converse";
        const cost = usage.cost && (usage.cost as Json).total;
        const priced =
            model !== undefined
                ? model.rateSource === "Pi registry"
                : typeof cost === "number" && Number.isFinite(cost) && cost > 0;
        const reply: SpendReply = {
            type: "reply",
            ...(this.config.preset === undefined ? {} : { preset: this.config.preset }),
            at: new Date(this.now()).toISOString(),
            session,
            model: typeof message.model === "string" ? message.model : (model?.id ?? "unknown"),
            region: regionOf(model?.baseUrl ?? ""),
            route,
            input: number(usage.input),
            output: number(usage.output),
            cacheRead: number(usage.cacheRead),
            cacheWrite: number(usage.cacheWrite),
            costUsd: priced ? Number((cost as number).toFixed(8)) : 0,
            priced,
        };
        const result = appendReply(this.env, reply);
        if (!result.ok) {
            this.warnWrite(session, model, message);
            return { error: result.error };
        }
        return { reply };
    }
    private warnWrite(session: string, _model: BedrockModel | undefined, _message: Json): void {
        if (this.writeWarned.has(session)) return;
        this.writeWarned.add(session);
    }
    takeWriteError(session: string): string | undefined {
        if (!this.writeWarned.has(session) || this.writeFailureNotified.has(session)) return undefined;
        this.writeFailureNotified.add(session);
        return "Bedrock spend could not be saved; this reply is not in the local total.";
    }
    footerText(): string {
        const view = this.withCommand(this.local());
        const limit = this.config.monthlyBudgetUsd;
        const short = MONTHS[Number(view.month.slice(5)) - 1] ?? view.month;
        const budget = limit === undefined ? "" : ` / $${Number.isInteger(limit) ? limit : limit.toFixed(2)}`;
        const prefix = this.config.preset === undefined ? "" : `${this.config.preset} · `;
        return `${prefix}${short} ${money(view.spentUsd)}${view.unpriced ? "+" : ""}${budget}`;
    }
    updateFooter(context: ExtensionContext): void {
        if (!context.hasUI || typeof context.ui.setStatus !== "function") return;
        if (!isOwnModel(context.model)) {
            context.ui.setStatus("jig-bedrock", undefined);
            return;
        }
        const view = this.withCommand(this.local());
        const limit = this.config.monthlyBudgetUsd;
        const text = this.footerText();
        const tone =
            limit !== undefined && view.spentUsd >= limit
                ? "error"
                : limit !== undefined && view.spentUsd >= limit * 0.8
                  ? "warning"
                  : undefined;
        let colored = text;
        if (tone) {
            const theme = (context.ui as { theme?: { fg?: (name: string, value: string) => string } }).theme;
            try {
                colored = theme?.fg?.(tone, text) ?? text;
            } catch {}
        }
        context.ui.setStatus("jig-bedrock", colored);
    }
    notice(context: ExtensionContext, atStart = false): void {
        if (!context.hasUI) return;
        const limit = this.config.monthlyBudgetUsd;
        if (limit === undefined || limit <= 0) return;
        const view = this.withCommand(this.local());
        const month = monthOf(this.now());
        if (atStart && view.spentUsd > limit) {
            // One line per session while over budget; mark the 100% threshold so a later reply does not repeat it.
            claim(this.env, month, "warned100");
            context.ui.notify(
                `Bedrock spend is over the ${money(limit)} monthly budget: ${money(view.spentUsd)}. This is a display figure, not an AWS limit; requests are not blocked.`,
                "warning",
            );
        } else if (view.spentUsd >= limit && claim(this.env, month, "warned100")) {
            context.ui.notify(
                `Bedrock spend is over the ${money(limit)} monthly budget (${money(view.spentUsd)}). This is a display figure, not an AWS limit; requests are not blocked.`,
                "warning",
            );
        } else if (view.spentUsd >= limit * 0.8 && view.spentUsd < limit && claim(this.env, month, "warned80")) {
            context.ui.notify(
                `Bedrock spend is at ${Math.floor((view.spentUsd / limit) * 100)}% of the ${money(limit)} monthly budget (${money(view.spentUsd)}). This is a display figure, not an AWS limit.`,
                "warning",
            );
        }
    }
    commandStatus(): string {
        if (this.config.spendCommand === undefined) return "not set";
        if (this.commandError) return this.commandError;
        if (this.command) return `ok ($${this.command.spentUsd.toFixed(2)} this month)`;
        return "not run yet";
    }
    async report(period: "day" | "week" | "month", ctx: ExtensionCommandContext): Promise<void> {
        const activeView = await this.refresh(true);
        const view = this.machine(period);
        const day = new Date(this.now()).toISOString().slice(0, 10);
        const periodLabel =
            period === "day" ? `today (${day})` : period === "week" ? "last 7 days" : monthLabel(view.month);
        const rows: string[] = [];
        const shown = view.models.slice(0, 8);
        const width = Math.max(8, ...shown.map((row) => row.model.length));
        const inWidth = Math.max(2, ...shown.map((row) => tokens(row.input + row.cacheRead + row.cacheWrite).length));
        const outWidth = Math.max(3, ...shown.map((row) => tokens(row.output).length));
        for (const row of shown) {
            const allInput = row.input + row.cacheRead + row.cacheWrite;
            const share = allInput === 0 ? 0 : Math.round((row.cacheRead / allInput) * 100);
            rows.push(
                `${row.model.padEnd(width)}  ${tableMoney(row.spentUsd).padStart(9)}  ${String(row.replies).padStart(6)} ${row.replies === 1 ? "reply" : "replies"}   in ${tokens(allInput).padEnd(inWidth)}   out ${tokens(row.output).padEnd(outWidth)}   cache read ${share}%`,
            );
        }
        if (view.models.length > shown.length) rows.push(`... and ${view.models.length - shown.length} more`);
        if (view.models.length === 0) rows.push("No replies recorded in this period.");
        rows.push(`${"Total".padEnd(width)}  ${tableMoney(view.spentUsd).padStart(9)}${view.unpriced ? " +" : ""}`);
        if ((view.presets ?? []).some((entry) => entry.preset !== "")) {
            rows.push("By preset:");
            const byPreset = [...(view.presets ?? [])].sort((a, b) => b.spentUsd - a.spentUsd);
            for (const entry of byPreset)
                rows.push(
                    `  ${(entry.preset === "" ? "no preset" : entry.preset).padEnd(12)} ${tableMoney(entry.spentUsd)}${entry.unpriced ? " +" : ""}`,
                );
        }
        rows.push(
            activeView.command
                ? `Your spend command: ${money(activeView.command.spentUsd)}`
                : "Your spend command: not set",
        );
        emit(ctx, `Bedrock spend · ${periodLabel} · this machine's Pi sessions`, rows);
    }
    async budgetReport(ctx: ExtensionCommandContext): Promise<void> {
        const view = await this.refresh(false);
        const limit = this.config.monthlyBudgetUsd;
        const rows = [
            `${limit !== undefined && view.spentUsd >= limit ? "!" : "✓"} Spent this month: ${money(view.spentUsd)}${view.unpriced ? " + unpriced usage" : ""}`,
            limit === undefined ? "– Budget: not set" : `${view.spentUsd >= limit ? "!" : "✓"} Budget: ${money(limit)}`,
            "! Not an AWS limit; no request is blocked.",
            ...(limit === undefined ? ["Next: /bedrock budget 200"] : []),
        ];
        emit(ctx, "Bedrock budget", rows);
    }
}
export function regionOf(baseUrl: string): string {
    return /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/.exec(baseUrl)?.[1] ?? "";
}
function emit(ctx: ExtensionCommandContext, title: string, rows: readonly string[]): void {
    const text = [title, ...rows].join("\n");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else process.stdout.write(`${text}\n`);
}
