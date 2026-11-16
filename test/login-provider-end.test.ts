import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Catalog } from "../src/catalog.ts";
import { jigBedrock } from "../src/index.ts";

function catalog(region: string, id = "claude-sonnet-5-5", count = 1): Catalog {
    return {
        schema: 1,
        mode: "system",
        aws_profile: "keys",
        account_id: "123456789012",
        regions: [region],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles: Array.from({ length: count }, (_, index) => ({
            arn: `arn:aws:bedrock:${region}:123456789012:inference-profile/global.anthropic.${id}${index === 0 ? "" : `-${index}`}`,
            profile_name: `${id}${index === 0 ? "" : `-${index}`}`,
            foundation_model_id: `anthropic.${id}`,
            region,
            kind: "system" as const,
        })),
    };
}

async function harness(
    t: test.TestContext,
    raw: Record<string, unknown>,
    discoveryWorks = true,
    timing: {
        delayMs?: number;
        lateRegion?: string;
        lateId?: string;
        failLate?: boolean;
        cached?: boolean;
        oldCount?: number;
        newCount?: number;
        emptyNew?: boolean;
    } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-login-end-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, AWS_CONFIG_FILE: join(dir, "config") };
    writeFileSync(env.AWS_CONFIG_FILE, "[profile keys]\nregion = us-east-1\n");
    if (discoveryWorks) writeFileSync(join(agent, "bedrock.json"), JSON.stringify(raw));
    else mkdirSync(join(agent, "bedrock.json"));
    const source = {
        load: () => {
            if (timing.cached) {
                try {
                    const saved = JSON.parse(readFileSync(join(agent, "bedrock.json"), "utf8")) as {
                        regions?: string[];
                    };
                    return catalog(saved.regions?.[0] ?? "us-east-1");
                } catch {
                    /* fall through */
                }
            }
            if (timing.emptyNew) {
                try {
                    const saved = JSON.parse(readFileSync(join(agent, "bedrock.json"), "utf8")) as {
                        regions?: string[];
                    };
                    if (saved.regions?.[0] !== "us-east-1") return undefined;
                } catch {
                    /* keep */
                }
            }
            return catalog("us-east-1", "claude-sonnet-5-5", timing.oldCount);
        },
        refresh: async () => {
            if (timing.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, timing.delayMs));
            if (timing.failLate) return "network" as const;
            let region = timing.lateRegion ?? "us-east-1";
            try {
                const saved = JSON.parse(readFileSync(join(agent, "bedrock.json"), "utf8")) as any;
                const body = saved.preset === undefined ? saved : (saved.presets?.[saved.preset] ?? saved);
                region = body.regions?.[0] ?? region;
            } catch {
                /* keep */
            }
            source.load = () => catalog(region, timing.lateId, timing.newCount);
            return "ok" as const;
        },
        status: () => (timing.failLate ? ("network" as const) : ("ok" as const)),
        failure: () => (timing.failLate ? "AWS could not be reached." : undefined),
    };
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const pi = {
        on(name: string, hook: (event: any, ctx: any) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand() {},
        events: { emit() {} },
        setModel: async () => true,
    };
    await jigBedrock({
        env,
        config: raw,
        catalog: source as never,
        listProfiles: async () => ["keys", "demo-sso"],
        ssoRecover: async () => {},
        verifyProfile: async () => ({ ok: true }),
        check: async () => ({
            node: { status: "ready", version: "22.19.0" },
            aws: { status: "ready", version: "2.34.0" },
            platform: "linux",
        }),
        backgroundRefresh: false,
        loginRefreshWaitMs: timing.delayMs === undefined ? undefined : 20,
    } as never)(pi as never);
    const notices: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: { find: () => undefined },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    return { dir, agent, env, providers, notices, ctx };
}

const answers = (prompt: any): string => {
    if (prompt.type === "select" && prompt.message?.includes("How do you sign in to AWS?")) return "existing";
    if (prompt.message === "Which AWS profile should Bedrock use?") return "profile:keys";
    if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
    if (prompt.message === "AWS regions for discovery (comma separated)") return "eu-west-1";
    return "";
};

test("a failed discovery save reaches ctx.ui.notify after login returns", async (t) => {
    const s = await harness(t, {}, false);
    const provider = s.providers.find((entry) => entry?.id === "jig-bedrock");
    await provider.auth.apiKey.login({
        signal: new AbortController().signal,
        prompt: async (prompt: any) => answers(prompt),
        notify: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(
        s.notices.some((notice) => notice.includes("Bedrock settings were not saved")),
        JSON.stringify(s.notices),
    );
});

test("login under an active preset saves into it and the session uses it", async (t) => {
    const s = await harness(t, {
        preset: "work",
        profile: "old",
        regions: ["us-east-1"],
        presets: { work: { profile: "old", regions: ["us-east-1"] } },
    });
    const provider = s.providers.find((entry) => entry?.id === "jig-bedrock");
    await provider.auth.apiKey.login({
        signal: new AbortController().signal,
        prompt: async (prompt: any) => answers(prompt),
        notify: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const saved = JSON.parse(readFileSync(join(s.agent, "bedrock.json"), "utf8"));
    assert.equal(saved.presets.work.profile, "keys");
    assert.deepEqual(saved.presets.work.regions, ["eu-west-1"]);
    assert.equal(saved.profile, "old");
    assert.deepEqual(saved.regions, ["us-east-1"]);
    assert.ok(
        s.notices.some((notice) => notice.includes("Saved to preset work.")),
        JSON.stringify(s.notices),
    );
    assert.doesNotMatch(s.notices.join("\n"), /preset add/);
    const models = s.providers.at(-1)?.getModels?.() ?? [];
    assert.ok(
        models.some((model: any) => String(model.baseUrl).includes("eu-west-1")),
        JSON.stringify(models),
    );
});

async function login(s: Awaited<ReturnType<typeof harness>>) {
    const provider = s.providers.find((entry: any) => entry?.id === "jig-bedrock");
    await provider.auth.apiKey.login({
        signal: new AbortController().signal,
        prompt: async (prompt: any) => answers(prompt),
        notify: () => {},
    });
}

test("a slow login says the models are loading, then announces the late result", async (t) => {
    const s = await harness(t, { profile: "old", regions: ["us-east-1"] }, true, {
        delayMs: 120,
        lateRegion: "eu-west-1",
    });
    await login(s);
    const first = s.notices.filter((notice) => notice.includes("Bedrock models loaded")).join("\n");
    assert.doesNotMatch(first, /loaded: \d/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.match(s.notices.join("\n"), /Bedrock: \d+ models in \/model/);
});

test("Pi's refreshModels hook returns promptly while the login refresh runs", async (t) => {
    const s = await harness(t, { profile: "old", regions: ["us-east-1"] }, true, {
        delayMs: 400,
        lateRegion: "eu-west-1",
    });
    await login(s);
    const provider = s.providers.at(-1);
    const started = Date.now();
    await provider.refreshModels({
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        publish: async (value: any) => {
            value.update();
            return true;
        },
    });
    assert.ok(Date.now() - started < 150, `hook took ${Date.now() - started} ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
});

test("a fresh cached catalog for the new settings is registered before the slow refresh", async (t) => {
    const s = await harness(t, { profile: "old", regions: ["us-east-1"] }, true, {
        delayMs: 400,
        lateRegion: "eu-west-1",
        cached: true,
    });
    const started = Date.now();
    await login(s);
    assert.ok(Date.now() - started < 200, `login took ${Date.now() - started} ms`);
    const models = s.providers.at(-1)?.getModels?.() ?? [];
    assert.ok(
        models.some((entry: any) => String(entry.baseUrl).includes("eu-west-1")),
        JSON.stringify(models),
    );
});

test("a failed late refresh after login is reported", async (t) => {
    const s = await harness(t, { profile: "old", regions: ["us-east-1"] }, true, {
        delayMs: 120,
        failLate: true,
    });
    await login(s);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.match(s.notices.join("\n"), /AWS could not be reached/);
});

test("a login that drops the session model gives one new-settings notice and the count", async (t) => {
    const s = await harness(t, { profile: "old", regions: ["us-east-1"] }, true, {
        delayMs: 120,
        lateRegion: "eu-west-1",
        lateId: "claude-haiku-5-5",
    });
    s.ctx.model = {
        id: "claude-sonnet-5-5",
        provider: "jig-bedrock",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    } as never;
    await login(s);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const text = s.notices.join("\n");
    assert.match(text, /not in the list for the new settings/);
    assert.match(text, /Bedrock: \d+ models in \/model \(\d+ left\)/);
    assert.doesNotMatch(text, /no longer in your account/);
    assert.doesNotMatch(text, /new model/);
    assert.doesNotMatch(text, /Saved Bedrock model is unavailable/);
});

test("a settings change counts the models left against the list before the change", async (t) => {
    const s = await harness(t, { profile: "old", regions: ["us-east-1"] }, true, {
        delayMs: 120,
        lateRegion: "eu-west-1",
        lateId: "claude-haiku-5-5",
        oldCount: 13,
        newCount: 8,
        emptyNew: true,
    });
    assert.equal(s.providers.at(-1)?.getModels?.().length, 13);
    await login(s);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const text = s.notices.join("\n");
    assert.match(text, /Bedrock: 8 models in \/model \(5 left\)/, text);
    assert.doesNotMatch(text, /8 new/);
});
