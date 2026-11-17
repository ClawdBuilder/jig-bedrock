/* biome-ignore-all lint/suspicious/noExplicitAny: Pi and provider doubles */
// Design §5-§7: JIG_BEDROCK_PRESET narrows the list, `allPresetModels: false` is the 0.6.3 shape, and start-up
// failures are one line per current preset plus one count for the others.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Catalog } from "../src/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { createBedrockProvider } from "../src/provider.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const catalog: Catalog = {
    schema: 1,
    mode: "system",
    aws_profile: "fixture",
    account_id: ACCOUNT,
    regions: [REGION],
    fetched_at: Math.floor(Date.now() / 1000),
    profiles: [
        {
            arn: `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-sonnet-5-5`,
            profile_name: "System Sonnet",
            foundation_model_id: "anthropic.claude-sonnet-5-5",
            region: REGION,
            kind: "system",
        },
    ],
};

function setup(
    t: test.TestContext,
    raw: Record<string, unknown>,
    options: { env?: NodeJS.ProcessEnv; catalog?: any; backgroundRefresh?: boolean; model?: unknown } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-preset-shape-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify(raw));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, ...options.env };
    const resolved = loadConfig({ raw, env, agentDir: agent });
    assert.ok(resolved.config, resolved.error);
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, any>();
    const providers: any[] = [];
    const notices: string[] = [];
    const selected: Array<{ provider: string; id: string }> = [];
    const ctx: any = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        model: options.model,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "test", getBranch: () => [] },
        modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    };
    const pi = {
        on(name: string, hook: (event: any, ctx: any) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            // Pi keeps one provider per id: a later registration replaces it.
            const at = providers.findIndex((entry) => entry.id === provider.id);
            if (at >= 0) providers.splice(at, 1, provider);
            else providers.push(provider);
        },
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
        unregisterProvider() {},
        events: { emit() {} },
        setModel: async (model: any) => {
            selected.push({ provider: model.provider, id: model.id });
            ctx.model = model;
            return true;
        },
    };
    const handle = createBedrockProvider({
        env,
        config: resolved.config,
        catalog: options.catalog ?? { load: () => catalog, refresh: async () => "ok" },
        listProfiles: async () => ["fixture", "work", "personal"],
        backgroundRefresh: options.backgroundRefresh ?? false,
    })(pi as never);
    const command = async (args: string): Promise<void> => {
        await commands.get("bedrock")?.handler(args, ctx);
    };
    return { dir, agent, env, hooks, providers, commands, notices, selected, ctx, pi, handle, command };
}

async function start(h: ReturnType<typeof setup>): Promise<any> {
    const handle = await h.handle;
    assert.ok(handle);
    for (const hook of h.hooks.get("session_start") ?? []) await hook({ reason: "startup" }, h.ctx);
    return handle;
}

const providerIds = (h: { providers: any[] }): string[] => h.providers.map((entry) => entry.id).sort();

test("JIG_BEDROCK_PRESET registers the plain provider plus that preset only", async (t) => {
    const h = setup(
        t,
        {
            profile: "fixture",
            regions: [REGION],
            presets: { work: { profile: "work" }, personal: { profile: "personal" } },
        },
        { env: { JIG_BEDROCK_PRESET: "work" } },
    );
    await start(h);
    assert.deepEqual(providerIds(h), ["jig-bedrock", "jig-bedrock-work"]);
});

test("an unknown JIG_BEDROCK_PRESET warns once and shows the plain provider only", async (t) => {
    const h = setup(
        t,
        { profile: "fixture", regions: [REGION], presets: { work: { profile: "work" } } },
        { env: { JIG_BEDROCK_PRESET: "ghost" } },
    );
    await start(h);
    assert.deepEqual(providerIds(h), ["jig-bedrock"]);
    const lines = h.notices.filter((text) => text.includes("JIG_BEDROCK_PRESET=ghost"));
    assert.equal(lines.length, 1, JSON.stringify(h.notices));
    assert.match(lines[0] ?? "", /plain provider only/);
});

test("allPresetModels: false is the 0.6.3 shape: one plain provider with the preset's models", async (t) => {
    const h = setup(t, {
        profile: "fixture",
        regions: [REGION],
        presets: { work: { profile: "work" } },
        preset: "work",
        allPresetModels: false,
    });
    const handle = await start(h);
    assert.deepEqual(providerIds(h), ["jig-bedrock"], "no per-preset provider");
    assert.deepEqual(
        h.providers[0]?.getModels?.().map((model: { id: string }) => model.id),
        ["claude-sonnet-5-5"],
        "the plain provider carries the preset's list",
    );
    assert.deepEqual(
        handle.models.map((model: { id: string }) => model.id),
        ["claude-sonnet-5-5"],
    );
});

test("the 0.6.3 shape switches presets on the one provider", async (t) => {
    const h = setup(t, {
        profile: "fixture",
        regions: [REGION],
        presets: { work: { profile: "work" }, personal: { profile: "personal" } },
        allPresetModels: false,
    });
    await start(h);
    await h.command("use work");
    assert.deepEqual(providerIds(h), ["jig-bedrock"], "still one provider");
    assert.deepEqual(h.selected.at(-1), { provider: "jig-bedrock", id: "claude-sonnet-5-5" });
    assert.equal(
        (JSON.parse(readFileSync(join(h.agent, "bedrock.json"), "utf8")) as { preset?: string }).preset,
        "work",
    );
    await h.command("use top");
    assert.equal(
        (JSON.parse(readFileSync(join(h.agent, "bedrock.json"), "utf8")) as { preset?: string }).preset,
        undefined,
    );
    const afterTop = JSON.parse(readFileSync(join(h.agent, "bedrock.json"), "utf8")) as { presets?: unknown };
    assert.ok(afterTop.presets, JSON.stringify(afterTop));
    await h.command("use");
    const listing = h.notices.join("\n");
    assert.match(listing, /work/, listing);
    assert.match(listing, /personal/, listing);
});

test("start-up failures say the current preset in full and count the others once", async (t) => {
    const failing = {
        load: () => undefined,
        refresh: async () => "throttled" as const,
        failure: () => "Could not list inference profiles: AWS throttled.",
        status: () => "throttled" as const,
        saveFailure: () => undefined,
    };
    const h = setup(
        t,
        {
            profile: "fixture",
            regions: [REGION],
            presets: { work: { profile: "work" }, personal: { profile: "personal" } },
        },
        { catalog: failing, backgroundRefresh: true, model: { provider: "jig-bedrock-work", id: "claude-sonnet-5-5" } },
    );
    await start(h);
    const until = async (check: () => boolean): Promise<void> => {
        for (let attempt = 0; attempt < 200 && !check(); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await until(() => h.notices.some((text) => text.includes("other preset")));
    const text = h.notices.join("\n");
    assert.match(text, /AWS is limiting requests for the AWS profile work/, "the current preset's cause is in full");
    const count = h.notices.filter((notice) => /other preset/.test(notice));
    assert.equal(count.length, 1, text);
    assert.match(count[0] ?? "", /2 other presets could not load their models: \/bedrock status in each/);
});
