import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";

type Hook = (...args: any[]) => any;

test("session shutdown cancels its pending background usage program report and stops the poll", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-lifecycle-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const hooks = new Map<string, Hook[]>();
    let signal: AbortSignal | undefined,
        stopped = 0,
        polls = 0;
    const pi: any = {
        on: (name: string, fn: Hook) => hooks.set(name, [...(hooks.get(name) || []), fn]),
        registerProvider() {},
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    await createBedrockProvider({
        env: {},
        backgroundRefresh: false,
        config: {
            team: "fixture",
            profile: "fixture",
            regions: ["us-east-1"],
            agentDir: dir,
            usageDir: dir,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: { load: () => undefined, refresh: async () => "ok" },
        ssoRecover: async () => {},
        budget: {
            load: () => undefined,
            refresh: async (options?: { signal?: AbortSignal }) => {
                polls++;
                signal = options?.signal;
                signal?.addEventListener("abort", () => {
                    stopped++;
                });
            },
        },
    })(pi);
    const ctx: any = {
        mode: "tui",
        model: { provider: "jig-bedrock", id: "m" },
        sessionManager: { getBranch: () => [], getSessionId: () => "fixture" },
        ui: { notify() {} },
        modelRegistry: { find: () => undefined },
    };
    for (const fn of hooks.get("session_start") || []) await fn({ type: "session_start" }, ctx);
    assert.ok(signal);
    assert.equal(polls, 1);
    for (const fn of hooks.get("session_shutdown") || []) await fn({}, ctx);
    assert.equal(stopped, 1);
});
test("the poll only runs while a Bedrock model is selected, and only in the terminal UI", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-lifecycle-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const hooks = new Map<string, Hook[]>();
    let polls = 0;
    const pi: any = {
        on: (name: string, fn: Hook) => hooks.set(name, [...(hooks.get(name) || []), fn]),
        registerProvider() {},
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    await createBedrockProvider({
        env: {},
        backgroundRefresh: false,
        config: {
            team: "fixture",
            profile: "fixture",
            regions: ["us-east-1"],
            agentDir: dir,
            usageDir: dir,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: { load: () => undefined, refresh: async () => "ok" },
        ssoRecover: async () => {},
        budget: {
            load: () => undefined,
            refresh: async () => {
                polls++;
            },
        },
    })(pi);
    const start = async (mode: string, provider: string) => {
        const ctx: any = {
            mode,
            model: { provider, id: "m" },
            sessionManager: { getBranch: () => [], getSessionId: () => "fixture" },
            ui: { notify() {} },
            modelRegistry: { find: () => undefined },
        };
        for (const fn of hooks.get("session_start") || []) await fn({ type: "session_start" }, ctx);
        for (const fn of hooks.get("session_shutdown") || []) await fn({}, ctx);
    };
    await start("rpc", "jig-bedrock");
    await start("tui", "openai-codex");
    assert.equal(polls, 0);
    await start("tui", "jig-bedrock");
    assert.equal(polls, 1);
});
