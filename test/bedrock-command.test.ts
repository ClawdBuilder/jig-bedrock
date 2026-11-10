// The one command: every sub-command, the completions, the old names and the always-present broken settings path.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerBedrockCommands, registerBrokenCommands } from "../src/commands.ts";
import { SpendTracker } from "../src/spend.ts";

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
    api: "anthropic-messages",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
    arn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/p",
    rateSource: "Pi registry",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
function harness(t: { after(fn: () => void): void }, env: NodeJS.ProcessEnv) {
    const root = mkdtempSync(join(tmpdir(), "bedrock-command-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const settings = { HOME: root, PI_CODING_AGENT_DIR: root, ...env };
    const notices: string[] = [];
    const commands = new Map<
        string,
        { handler: (args: string, ctx: never) => Promise<void>; getArgumentCompletions?: unknown }
    >();
    const pi = {
        registerCommand(name: string, value: { handler: (args: string, ctx: never) => Promise<void> }) {
            commands.set(name, value);
        },
    };
    const spend = new SpendTracker({ ...config, agentDir: root }, settings, () => Date.UTC(2026, 10, 15, 12));
    const result = registerBedrockCommands(pi as never, {
        config: { ...config, agentDir: root },
        spend,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        models: () => [model as never],
        env: settings,
        refresh: async () => "ok",
        lastChoice: () => ({ profile: "fixture", exists: true }),
        unavailable: () => [],
    });
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s" },
    };
    return { root, settings, notices, commands, result, ctx };
}

test("every sub-command prints a titled block and usage has no stale Next", async (t) => {
    const h = harness(t, {});
    for (const args of [
        "status",
        "models",
        "settings",
        "help",
        "usage",
        "usage day",
        "budget",
        "budget 200",
        "budget off",
    ]) {
        await h.result.bedrock(args, h.ctx as never);
    }
    assert.ok(h.notices.length >= 9);
    for (const text of h.notices) {
        assert.match(text, /^Bedrock /);
        assert.ok(
            text.split("\n").every((line) => line.length <= 100),
            text,
        );
    }
    assert.doesNotMatch(h.notices.find((text) => text.startsWith("Bedrock spend")) ?? "", /^Next:/m);
    assert.match(h.notices.find((text) => text.startsWith("Bedrock spend")) ?? "", /· this machine's Pi sessions/);
    assert.match(
        h.notices.find((text) => text.startsWith("Bedrock models")) ?? "",
        /claude-sonnet-5-5 · us-east-1 · Messages ·/,
    );
});

test("set and unset write the settings file and apply", async (t) => {
    const h = harness(t, {});
    await h.result.bedrock("set api converse", h.ctx as never);
    assert.match(readFileSync(join(h.root, "bedrock.json"), "utf8"), /"api": "converse"/);
    await h.result.bedrock("unset api", h.ctx as never);
    assert.doesNotMatch(readFileSync(join(h.root, "bedrock.json"), "utf8"), /"api"/);
});

test("completions list sub-commands and setting names", () => {
    const h = harness({ after() {} }, {});
    assert.ok(h.result.completions("us").some((item) => item.value === "usage"));
    assert.ok(h.result.completions("set pro").some((item) => item.value === "profile"));
});

test("old names append the deprecation line", async (t) => {
    const h = harness(t, {});
    const legacy = h.commands.get("bedrock-doctor");
    assert.ok(legacy);
    await legacy.handler("", h.ctx as never);
    assert.match(h.notices.at(-1) ?? "", /\nThis name goes away in the next release: use \/bedrock doctor\.$/);
});

test("broken settings still register /bedrock and repair through set", async (t) => {
    const h = harness(t, {});
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const pi = { registerCommand: (name: string, value: never) => commands.set(name, value) };
    const file = join(h.root, "bedrock.json");
    writeFileSync(file, JSON.stringify({ regions: [] }));
    const handler = registerBrokenCommands(pi as never, {
        file,
        error: "bedrock.regions must contain 1-16 unique AWS region names.",
        env: h.settings,
    });
    await handler("status", h.ctx as never);
    assert.match(h.notices[0]!, /^Bedrock · status: 1 problem/);
    await handler("set regions us-east-1", h.ctx as never);
    assert.match(readFileSync(file, "utf8"), /"regions": \[/);
    assert.match(h.notices.at(-1) ?? "", /Run \/reload/);
    assert.ok(commands.has("bedrock-doctor"));
});

test("a broken settings file still registers /bedrock and its old names", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bedrock-broken-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "bedrock.json"), JSON.stringify({ regions: [] }));
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
        on: (name: string, hook: (event: unknown, ctx: unknown) => unknown) =>
            hooks.set(name, [...(hooks.get(name) ?? []), hook]),
        registerCommand: (name: string, value: never) => commands.set(name, value),
        registerProvider() {},
        setModel: () => false,
    };
    const { createBedrockProvider } = await import("../src/provider.ts");
    const handle = await createBedrockProvider({ env: { HOME: root, PI_CODING_AGENT_DIR: root } })(pi as never);
    assert.equal(handle, undefined);
    assert.ok(commands.has("bedrock"));
    assert.ok(commands.has("bedrock-doctor"));
    const notices: string[] = [];
    await commands.get("bedrock")?.handler("status", {
        hasUI: true,
        mode: "rpc",
        ui: { notify: (text: string) => notices.push(text) },
    } as never);
    assert.match(notices[0]!, /^Bedrock · status: 1 problem/);
    assert.match(notices[0]!, /regions/);
});
