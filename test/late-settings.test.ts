// Jig can load after jig-bedrock (the install order is Pi's), so settings arrive after the discovery object exists. The
// scope must be recomputed then: a cache that matches the new profile/team is used before any AWS CLI call.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwsDiscovery, type Runner } from "../src/aws-discovery.ts";
import { registerBedrockSelectionGuard } from "../src/catalog.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { createJigBedrock } from "../src/provider.ts";

const ACCOUNT = "123456789012";
const ARN = `arn:aws:bedrock:us-east-1:${ACCOUNT}:application-inference-profile/orders-api`;

function config(team: string | undefined, profile: string | undefined): ResolvedConfig {
    return {
        team,
        tagKey: team === undefined ? undefined : "Team",
        tagValue: team,
        profile,
        regions: ["us-east-1"],
        usageDir: "/missing-usage",
        ssoLoginCommand: ["aws", "sso", "login", "--profile", "{profile}"],
        signInAtStart: false,
    } as ResolvedConfig;
}

function runner(): { runner: Runner; calls: number } {
    const state = { calls: 0 };
    const runner: Runner = async (_program, args) => {
        state.calls++;
        if (args.includes("get-caller-identity")) return JSON.stringify({ Account: ACCOUNT });
        if (args.includes("get-inference-profile")) {
            const identifier = args[args.indexOf("--inference-profile-identifier") + 1];
            return JSON.stringify({
                inferenceProfileArn: identifier,
                inferenceProfileName: "Orders API",
                status: "ACTIVE",
                models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5" }],
            });
        }
        return JSON.stringify({
            ResourceTagMappingList: [
                {
                    ResourceARN: ARN,
                    Tags: [
                        { Key: "Team", Value: "late-team" },
                        { Key: "Active", Value: "true" },
                    ],
                },
            ],
        });
    };
    return {
        get calls() {
            return state.calls;
        },
        runner,
    };
}

test("late settings use a matching cache with zero AWS CLI calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "late-cache-"));
    try {
        const file = join(dir, "catalog.json");
        // A cache written for the scope the late settings will produce.
        const writer = createAwsDiscovery(config("late-team", "late-profile"), runner().runner, file);
        assert.equal(await writer.refresh(true), "ok");

        const late = config(undefined, undefined);
        let calls = 0;
        const source = createAwsDiscovery(
            late,
            async () => {
                calls++;
                throw new Error("the CLI must not be called when the cache matches");
            },
            file,
        );
        assert.equal(source.load(), undefined, "nothing matches before Jig's section arrives");

        // #14's late applySettings mutates this same config object.
        late.profile = "late-profile";
        late.team = "late-team";
        late.tagKey = "Team";
        late.tagValue = "late-team";
        assert.equal(await source.refresh(false), "ok");
        assert.equal(calls, 0, "the cache answered; no aws process ran");
        assert.equal(source.load()?.profiles.length, 1);
        assert.equal(source.load()?.profiles[0]?.arn, ARN);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a 15-second CLI is never reached when the late scope has a matching cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "late-cache-slow-"));
    try {
        const file = join(dir, "catalog.json");
        const writer = createAwsDiscovery(config("late-team", "late-profile"), runner().runner, file);
        assert.equal(await writer.refresh(true), "ok");
        const late = config(undefined, undefined);
        let calls = 0;
        const source = createAwsDiscovery(
            late,
            async () => {
                calls++;
                await new Promise((resolve) => setTimeout(resolve, 15_000));
                throw new Error("slow AWS");
            },
            file,
        );
        late.profile = "late-profile";
        late.team = "late-team";
        late.tagKey = "Team";
        late.tagValue = "late-team";
        assert.equal(await source.refresh(false), "ok");
        assert.equal(calls, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

function guardHarness(notices: string[], slow: () => boolean) {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    registerBedrockSelectionGuard(
        {
            on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, fn),
            setModel: async () => true,
        } as never,
        [],
        { deferStartupWarning: () => true, discoverySlow: slow },
    );
    return hooks;
}

test("slow discovery warns that AWS is slow, not that the saved model is unavailable", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "late-cache-guard-"));
    const before = { ...process.env };
    t.after(() => {
        process.env = before;
        rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ defaultProvider: "jig-bedrock", defaultModel: "orders-api" }),
    );
    process.env.PI_CODING_AGENT_DIR = dir;
    const notices: string[] = [];
    const hooks = guardHarness(notices, () => true);
    const ctx = {
        mode: "tui",
        model: undefined,
        sessionManager: { getBranch: () => [] },
        modelRegistry: { find: () => undefined },
        ui: {
            notify: (text: string) => notices.push(text),
            setEditorText: () => {},
        },
    };
    await hooks.get("session_start")!({}, ctx);
    assert.equal(notices.length, 0, "the start-up notice is deferred to the provider's own 'still loading' line");
    const result = hooks.get("input")!({ source: "interactive", text: "hello" }, ctx) as { action: string };
    assert.equal(result.action, "handled");
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /AWS discovery is slow/);
    assert.doesNotMatch(notices[0]!, /unavailable or ambiguous/);
});

test("a timed-out refresh notifies that AWS is slow while no models are loaded", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "late-cache-provider-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const notices: string[] = [];
    const pi = {
        on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), fn]);
        },
        registerProvider() {},
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    await createJigBedrock({
        env: { HOME: dir, PI_CODING_AGENT_DIR: dir, LANG: "C.UTF-8", NO_COLOR: "1", TERM: "xterm-256color" },
        config: {
            profile: "my-profile",
            regions: ["us-east-1"],
            usageDir: "/missing-usage",
            ssoLoginCommand: ["aws", "sso", "login", "--profile", "{profile}"],
            signInAtStart: false,
        } as ResolvedConfig,
        listProfiles: async () => ["my-profile"],
        catalog: { load: () => undefined, refresh: async () => "timeout" },
        backgroundRefresh: true,
        usageEvents: false,
    })(pi as never);
    const ctx = {
        mode: "tui",
        model: undefined,
        sessionManager: { getBranch: () => [], getSessionId: () => "test" },
        modelRegistry: { find: () => undefined },
        ui: { notify: (text: string) => notices.push(text), setEditorText: () => {}, setStatus: () => {} },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
        notices.some((text) => /AWS discovery is slow/.test(text)),
        notices.join("\n"),
    );
    assert.doesNotMatch(notices.join("\n"), /unavailable or ambiguous/);
});
