// The local spend record, the optional spend command, the budget state and the footer.
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBedrockCommands } from "../src/commands.ts";
import {
    appendReply,
    importEarlier,
    localView,
    readMonth,
    runSpendCommand,
    type SpendReply,
    SpendTracker,
    spendFolder,
} from "../src/spend.ts";

const config = {
    team: "fixture",
    profile: "fixture",
    regions: ["us-east-1"],
    monthlyBudgetUsd: 100,
    ssoLoginCommand: [],
    signInAtStart: false,
    agentDir: "/tmp",
};
const model = {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    api: "anthropic-messages" as const,
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
    arn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/p",
    foundationModelId: "anthropic.claude-sonnet-5-5",
    rateSource: "Pi registry" as const,
    reasoning: true,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const now = Date.UTC(2026, 10, 15, 12, 0, 0);
function folder(t: { after(fn: () => void): void }): string {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-spend-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const reply = (overrides: Partial<SpendReply> = {}): SpendReply => ({
    type: "reply",
    at: "2026-11-15T10:00:00.000Z",
    session: "s",
    model: "claude-sonnet-5-5",
    region: "us-east-1",
    route: "messages",
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 1,
    costUsd: 1.25,
    priced: true,
    ...overrides,
});
function ctx(extra: Record<string, unknown> = {}) {
    const notices: string[] = [];
    const statuses: Array<string | undefined> = [];
    return {
        notices,
        statuses,
        value: {
            hasUI: true,
            mode: "rpc",
            model: { provider: "jig-bedrock", id: model.id },
            ui: {
                notify: (text: string) => notices.push(text),
                setStatus: (_key: string, text: string | undefined) => statuses.push(text),
            },
            sessionManager: { getSessionId: () => "s" },
            ...extra,
        } as unknown as ExtensionContext,
    };
}

test("the record is one private line per reply and totals only priced replies", (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root };
    assert.deepEqual(appendReply(env, reply()), { ok: true });
    assert.deepEqual(appendReply(env, reply({ priced: false, costUsd: 0, model: "unpriced" })), { ok: true });
    const files = readdirSafe(join(spendFolder(env)));
    assert.ok(files.includes("2026-11.jsonl"));
    assert.equal(statSync(join(spendFolder(env), "2026-11.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(spendFolder(env)).mode & 0o777, 0o700);
    const totals = localView(env, "2026-11", "month", now);
    assert.equal(totals.spentUsd, 1.25);
    assert.equal(totals.unpriced, true);
    assert.equal(readMonth(env, "2026-11").length, 2);
    assert.doesNotMatch(
        readFileSync(join(spendFolder(env), "2026-11.jsonl"), "utf8"),
        /prompt|arn:aws|account|fixture/,
    );
});
function readdirSafe(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

test("earlier sessions are imported once and never counted twice", async (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root };
    const agent = join(root, "agent");
    mkdirSync(join(agent, "sessions", "project"), { recursive: true });
    const session = join(agent, "sessions", "project", "s.jsonl");
    writeFileSync(
        session,
        [
            JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-11-15T09:00:00.000Z", cwd: "/" }),
            JSON.stringify({
                type: "message",
                id: "m",
                parentId: null,
                timestamp: "2026-11-15T09:01:00.000Z",
                message: {
                    role: "assistant",
                    provider: "jig-bedrock",
                    model: "claude-sonnet-5-5",
                    api: "anthropic-messages",
                    timestamp: Date.UTC(2026, 10, 15, 9, 1),
                    usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
                },
            }),
            JSON.stringify({
                type: "message",
                id: "m2",
                parentId: "m",
                timestamp: "2026-11-15T09:02:00.000Z",
                message: {
                    role: "assistant",
                    provider: "amazon-bedrock",
                    model: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/orders",
                    api: "bedrock-converse-stream",
                    timestamp: Date.UTC(2026, 10, 15, 9, 2),
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
                },
            }),
        ].join("\n"),
    );
    assert.equal(
        (
            await importEarlier(env, agent, "2026-11", now, undefined, (arn) =>
                arn.endsWith("/orders") ? "claude-haiku-5-5" : undefined,
            )
        ).imported,
        2,
    );
    assert.deepEqual(
        readMonth(env, "2026-11").map((entry) => [entry.model, entry.costUsd]),
        [
            ["claude-sonnet-5-5", 0.5],
            ["claude-haiku-5-5", 0.25],
        ],
    );
    assert.equal((await importEarlier(env, agent, "2026-11", now)).imported, 0);
    assert.equal(readMonth(env, "2026-11").length, 2, "the import marker stops a second run");
});

test("the footer is the month and total, with the budget and a plus for unpriced replies", (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root };
    appendReply(env, reply());
    appendReply(env, reply({ priced: false, costUsd: 0 }));
    const tracker = new SpendTracker(config, env, () => now);
    assert.equal(tracker.footerText(), "Nov $1.25+ / $100");
    const context = ctx();
    tracker.updateFooter(context.value);
    assert.equal(context.statuses[0], "Nov $1.25+ / $100");
    context.value.model = { provider: "amazon-bedrock", id: "plain" };
    tracker.updateFooter(context.value);
    assert.equal(context.statuses[1], undefined, "another provider clears the status");
    const noBudget = new SpendTracker({ ...config, monthlyBudgetUsd: undefined }, env, () => now);
    assert.equal(noBudget.footerText(), "Nov $1.25+");
});

test("each budget threshold is announced once per month, and session start repeats only the over-100 line", (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root };
    appendReply(env, reply({ costUsd: 85 }));
    const first = new SpendTracker(config, env, () => now);
    const a = ctx();
    first.notice(a.value);
    assert.equal(a.notices.length, 1);
    assert.match(a.notices[0]!, /85%/);
    const b = ctx();
    first.notice(b.value);
    assert.equal(b.notices.length, 0, "the 80% threshold is not repeated");
    const other = new SpendTracker(config, env, () => now);
    const c = ctx();
    other.notice(c.value);
    assert.equal(c.notices.length, 0, "another process reads the same state");
    appendReply(env, reply({ costUsd: 20 }));
    const above = ctx();
    other.notice(above.value);
    assert.equal(above.notices.length, 1);
    assert.match(above.notices[0]!, /over the \$100/);
    const start = ctx();
    other.notice(start.value, true);
    assert.equal(start.notices.length, 1, "the threshold is claimed, but the start line remains");
    assert.match(start.notices[0]!, /over the \$100/);
});

test("the optional spend command supplies the figure, and a failure falls back to the local record", async (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root, ...process.env };
    const good = join(root, "spend.mjs");
    writeFileSync(
        good,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "env.json"))}, JSON.stringify({ profile: process.env.AWS_PROFILE, region: process.env.AWS_REGION }));\n` +
            `console.log(JSON.stringify({ month: "2026-11", spentUsd: 203.4 }))\n`,
    );
    const tracker = new SpendTracker({ ...config, spendCommand: [process.execPath, good] }, env, () => now);
    const view = await tracker.refresh(true);
    assert.equal(view.spentUsd, 203.4);
    assert.equal(view.command?.spentUsd, 203.4);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "env.json"), "utf8")), {
        profile: "fixture",
        region: "us-east-1",
    });
    const bad = join(root, "bad.mjs");
    writeFileSync(bad, "process.exit(3)\n");
    const failed = new SpendTracker({ ...config, spendCommand: [process.execPath, bad] }, env, () => now);
    const fallback = await failed.refresh(true);
    assert.equal(fallback.spentUsd, 0);
    assert.match(fallback.commandError ?? "", /exit code 3/);
    await assert.rejects(runSpendCommand({ ...config, spendCommand: [process.execPath, bad] }, () => now, { env }));
});

test("commands print one block, set and clear the budget, and write the setting", async (t) => {
    const root = folder(t);
    const env = { HOME: root, PI_CODING_AGENT_DIR: root, XDG_STATE_HOME: root };
    appendReply(env, reply());
    const tracker = new SpendTracker(config, env, () => now);
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    const notices: string[] = [];
    const pi = {
        registerCommand(
            name: string,
            value: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
        ) {
            commands.set(name, value);
        },
    };
    const result = registerBedrockCommands(pi as never, {
        config: { ...config, monthlyBudgetUsd: undefined },
        spend: tracker,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        models: () => [model as never],
        env,
    });
    const context = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text) },
        sessionManager: { getSessionId: () => "s" },
    };
    await result.bedrock("usage", context as never);
    await result.bedrock("usage day", context as never);
    await result.bedrock("budget", context as never);
    await result.bedrock("budget 200", context as never);
    await result.bedrock("budget off", context as never);
    assert.equal(notices.length, 5);
    for (const text of notices) {
        assert.ok(
            text.split("\n").every((line) => line.length <= 100),
            text,
        );
        assert.ok((text.match(/^Next:/gm)?.length ?? 0) <= 1, text);
        assert.match(text, /^Bedrock /);
    }
    assert.match(notices[3]!, /Budget set to \$200/);
    assert.match(notices[4]!, /Budget removed/);
    assert.equal(existsSync(join(root, "bedrock.json")), true);
    assert.equal(JSON.parse(readFileSync(join(root, "bedrock.json"), "utf8")).monthlyBudgetUsd, undefined);
});

test("a model with no price is recorded as unpriced and shown with a plus", async (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root };
    const free = {
        ...model,
        id: "free-model",
        rateSource: "no price" as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const tracker = new SpendTracker({ ...config, monthlyBudgetUsd: undefined }, env, () => now);
    tracker.record(
        {
            role: "assistant",
            provider: "jig-bedrock",
            api: "anthropic-messages",
            model: free.id,
            stopReason: "stop",
            usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
        "s",
        free as never,
    );
    assert.equal(tracker.footerText(), "Nov $0.00+");
    const notices: string[] = [];
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    const result = registerBedrockCommands(
        { registerCommand: (name: string, value: never) => commands.set(name, value) } as never,
        {
            config: { ...config, monthlyBudgetUsd: undefined },
            spend: tracker,
            catalog: { load: () => undefined, refresh: async () => "ok" },
            models: () => [free as never],
            env,
        },
    );
    await result.bedrock("usage", {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text) },
    } as never);
    assert.match(notices[0]!, /this machine's Pi sessions\nfree-model.*\$0\.00/);
});

test("a command without a UI writes the same block to standard output", async (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root };
    const tracker = new SpendTracker({ ...config, monthlyBudgetUsd: undefined }, env, () => now);
    const result = registerBedrockCommands({ registerCommand() {} } as never, {
        config: { ...config, monthlyBudgetUsd: undefined },
        spend: tracker,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        models: () => [model as never],
        env,
    });
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
        chunks.push(String(chunk));
        return true;
    }) as never;
    try {
        await result.bedrock("usage", {
            hasUI: false,
            mode: "print",
            signal: new AbortController().signal,
            ui: {},
        } as never);
    } finally {
        process.stdout.write = original;
    }
    assert.match(chunks.join(""), /^Bedrock spend · Nov 2026 · this machine's Pi sessions\nNo replies recorded/);
});

test("the doctor names why the spend command failed", async (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root };
    const bad = join(root, "bad.mjs");
    writeFileSync(bad, "process.exit(2)\n");
    const tracker = new SpendTracker({ ...config, spendCommand: [process.execPath, bad] }, env, () => now);
    await tracker.refresh(true);
    const notices: string[] = [];
    const result = registerBedrockCommands({ registerCommand() {} } as never, {
        config: { ...config, spendCommand: [process.execPath, bad] },
        spend: tracker,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        models: () => [model as never],
        env,
        check: async () => ({
            node: { status: "ready" as const, version: "22.19.0" },
            aws: { status: "ready" as const, version: "2.22.1" },
            platform: "linux" as const,
        }),
    });
    await result.bedrock("doctor", {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text) },
    } as never);
    assert.match(notices[0]!, /Spend command: exit code 2/);
});

test("the provider records a reply and updates the footer", async (t) => {
    const root = folder(t);
    const env = { XDG_STATE_HOME: root, HOME: root, PI_CODING_AGENT_DIR: root };
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const notices: string[] = [];
    const statuses: Array<string | undefined> = [];
    const pi = {
        on: (name: string, hook: (event: unknown, ctx: unknown) => unknown) =>
            hooks.set(name, [...(hooks.get(name) ?? []), hook]),
        registerProvider() {},
        registerCommand() {},
        setModel: () => false,
    };
    const { createBedrockProvider } = await import("../src/provider.ts");
    await createBedrockProvider({
        env,
        config: {
            team: "fixture",
            profile: "fixture",
            regions: ["us-east-1"],
            monthlyBudgetUsd: undefined,
            ssoLoginCommand: [],
            signInAtStart: false,
            agentDir: root,
        },
        catalog: { load: () => undefined, refresh: async () => "ok" },
        listProfiles: async () => [],
        backgroundRefresh: false,
        ssoRecover: async () => {},
    })(pi as never);
    const context = {
        hasUI: true,
        mode: "rpc",
        model: { provider: "jig-bedrock", id: "claude-sonnet-5-5" },
        ui: {
            notify: (text: string) => notices.push(text),
            setStatus: (_k: string, text?: string) => statuses.push(text),
        },
        sessionManager: { getSessionId: () => "s" },
    };
    const hook = hooks.get("message_end")?.[0];
    assert.ok(hook);
    await hook(
        {
            message: {
                role: "assistant",
                provider: "jig-bedrock",
                api: "anthropic-messages",
                model: "claude-sonnet-5-5",
                stopReason: "stop",
                usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 12.4 } },
            },
        },
        context,
    );
    assert.equal(statuses.at(-1), "Nov $12", "no model pricing entry, so the cost is recorded as priced");
    const file = join(spendFolder(env), "2026-11.jsonl");
    assert.match(readFileSync(file, "utf8"), /"costUsd":12\.4/);
    assert.equal(notices.length, 0);
});

test("sub-cent money and eight-decimal cost are stored and printed as the rules ask", async (t) => {
    const { formatMoney } = await import("../src/spend.ts");
    assert.equal(formatMoney(0.00003), "<$0.01");
    assert.equal(formatMoney(9.99), "$9.99");
    assert.equal(formatMoney(10), "$10");
    const root = folder(t);
    const env = { XDG_STATE_HOME: root };
    const tracker = new SpendTracker(config, env, () => now);
    tracker.record(
        {
            role: "assistant",
            provider: "jig-bedrock",
            api: "anthropic-messages",
            model: "claude-sonnet-5-5",
            stopReason: "stop",
            usage: {
                input: 1,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: Number("0.000030000000000000003") },
            },
        },
        "s",
        model as never,
    );
    const stored = JSON.parse(readFileSync(join(spendFolder(env), "2026-11.jsonl"), "utf8").trim()) as {
        costUsd: number;
    };
    assert.equal(stored.costUsd, 0.00003);
});
