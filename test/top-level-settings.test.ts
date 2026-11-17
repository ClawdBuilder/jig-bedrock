/* biome-ignore-all lint/suspicious/noExplicitAny: provider and Pi doubles */
/* biome-ignore-all lint/style/noNonNullAssertion: test assertions */
// The top-level settings are a choice beside the presets: /bedrock use top returns to them, and setting or unsetting
// the preset setting switches exactly like use. "top" can never be a preset name.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const profiles: FakeAwsProfile[] = [
    {
        arn: `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/team-app`,
        name: "team-app",
        region: REGION,
        foundation: "anthropic.claude-sonnet-5-5",
        tags: { Team: "fixture-team", Active: "true" },
        kind: "application",
    },
    {
        arn: `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-haiku-5-5`,
        name: "System Haiku",
        region: REGION,
        foundation: "anthropic.claude-haiku-5-5",
        tags: {},
        kind: "system",
    },
];
const TOP_TAG = {
    profile: "fixture",
    tagKey: "Team",
    tagValue: "fixture-team",
    activeTagKey: "Active",
    activeTagValue: "true",
    regions: [REGION],
};
const DEV = { dev: { profile: "fixture", discovery: "aws-defined" } };
const TOP_WITH_DEV = { ...TOP_TAG, presets: DEV };
const WITH_DEV = { ...TOP_WITH_DEV, preset: "dev" };

async function start(t: test.TestContext, raw: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-top-level-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const file = join(agent, "bedrock.json");
    writeFileSync(file, JSON.stringify(raw));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(dir, "cache") };
    const fake = fakeAwsHttp({ profiles });
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const commands = new Map<string, any>();
    const notices: string[] = [];
    const ctx: any = {
        hasUI: true,
        mode: "tui",
        signal: new AbortController().signal,
        model: undefined,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "test", getBranch: () => [] },
        modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    };
    const pi = {
        on(name: string, hook: (event: any, ctx: any) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async (model: any) => {
            ctx.model = model;
            return true;
        },
    };
    const handle = await createBedrockProvider({
        env,
        catalog: undefined,
        listProfiles: async () => ["fixture"],
        loginListProfiles: async () => ["fixture"],
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" }),
        backgroundRefresh: false,
    } as never)(pi as never);
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    return { dir, agent, file, env, fake, providers, commands, notices, ctx, handle };
}

const ids = (h: Awaited<ReturnType<typeof start>>): string[] =>
    h.providers
        .at(-1)
        ?.getModels?.()
        .map((model: { id: string }) => model.id) ?? [];

/** Refresh one preset's provider the way Pi's /model does, and return its model ids. */
async function loadPreset(h: Awaited<ReturnType<typeof start>>, id: string): Promise<string[]> {
    const provider = [...h.providers].reverse().find((entry: any) => entry.id === id);
    assert.ok(provider, `${id} is registered`);
    await provider.refreshModels({
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        publish: async () => true,
    });
    return (
        [...h.providers]
            .reverse()
            .find((entry: any) => entry.id === id)
            ?.getModels?.()
            .map((model: { id: string }) => model.id) ?? []
    );
}

async function untilModel(h: Awaited<ReturnType<typeof start>>, id: string): Promise<string[]> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const list = ids(h);
        if (list.includes(id)) return list;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return ids(h);
}

async function command(h: Awaited<ReturnType<typeof start>>, args: string): Promise<void> {
    await h.commands.get("bedrock")?.handler(args, h.ctx);
}

test("/bedrock use top selects the top-level settings' model", async (t) => {
    const h = await start(t, WITH_DEV);
    assert.equal(await h.handle.refresh(false), "ok");
    const dev = await loadPreset(h, "jig-bedrock-dev");
    assert.ok(dev.includes("claude-haiku-5-5"), JSON.stringify(dev));
    h.ctx.model = { provider: "jig-bedrock-dev", id: "claude-haiku-5-5" };
    await command(h, "use top");
    assert.deepEqual(
        { provider: h.ctx.model.provider, id: h.ctx.model.id },
        {
            provider: "jig-bedrock",
            id: "claude-sonnet-5-5",
        },
    );
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as { preset?: string };
    assert.equal(saved.preset, undefined, "the preset setting is removed");
    assert.match(h.notices.join("\n"), /Top-level settings are active: fixture · by tag/);
});

test("the Presets menu lists the top-level settings and switches to them", async (t) => {
    const h = await start(t, WITH_DEV);
    assert.equal(await h.handle.refresh(false), "ok");
    const calls: Array<{ title: string; options: string[] }> = [];
    const answers: Array<string | undefined> = ["Presets", "Top-level settings — fixture · by tag"];
    h.ctx.ui.select = async (title: string, options: string[] = []) => {
        calls.push({ title, options: [...options] });
        const wanted = answers.shift();
        if (wanted === undefined) return undefined;
        return options.find((option) => option === wanted || option.includes(wanted)) ?? wanted;
    };
    await command(h, "");
    const menu = calls.find((call) => call.title.startsWith("Bedrock presets"));
    assert.ok(menu, JSON.stringify(calls));
    assert.ok(
        menu?.options.some((option) => option.includes("Top-level settings — fixture · by tag")),
        JSON.stringify(menu?.options),
    );
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as { preset?: string };
    assert.equal(saved.preset, undefined);
    assert.match(h.notices.join("\n"), /Top-level settings are active: fixture · by tag/);

    // With no preset active, that row is marked active.
    const after: Array<{ title: string; options: string[] }> = [];
    const cancellations: Array<string | undefined> = ["Presets", undefined];
    h.ctx.ui.select = async (title: string, options: string[] = []) => {
        after.push({ title, options: [...options] });
        const wanted = cancellations.shift();
        if (wanted === undefined) return undefined;
        return options.find((option) => option === wanted || option.startsWith(wanted)) ?? wanted;
    };
    await command(h, "");
    const reopened = after.find((call) => call.title.startsWith("Bedrock presets"));
    assert.ok(reopened, JSON.stringify(after));
    assert.match(
        reopened?.options.find((option) => option.includes("Top-level settings")) ?? "",
        /active/,
        JSON.stringify(reopened?.options),
    );
});

test("/bedrock unset preset selects the top-level model and says so", async (t) => {
    const h = await start(t, WITH_DEV);
    assert.equal(await h.handle.refresh(false), "ok");
    await loadPreset(h, "jig-bedrock-dev");
    h.ctx.model = { provider: "jig-bedrock-dev", id: "claude-haiku-5-5" };
    await command(h, "unset preset");
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as { preset?: string };
    assert.equal(saved.preset, undefined);
    assert.equal(h.ctx.model.provider, "jig-bedrock");
    assert.equal(h.ctx.model.id, "claude-sonnet-5-5", "the top-level settings' model, not the preset's");
    assert.match(h.notices.join("\n"), /Top-level settings are active: fixture · by tag/);
});

test("/bedrock set preset selects that model and says one line", async (t) => {
    const h = await start(t, TOP_WITH_DEV);
    assert.equal(await h.handle.refresh(false), "ok");
    const dev = await loadPreset(h, "jig-bedrock-dev");
    assert.ok(dev.includes("claude-haiku-5-5"), JSON.stringify(dev));
    await command(h, "set preset dev");
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as { preset?: string };
    assert.equal(saved.preset, "dev", h.notices.join("\n"));
    assert.match(h.notices.join("\n"), /preset dev is active/i);
    assert.doesNotMatch(h.notices.join("\n"), /preset: dev \(saved to preset dev\)/);
    assert.equal(h.ctx.model.provider, "jig-bedrock-dev");
    assert.equal(h.ctx.model.id, "claude-haiku-5-5");
});

test("a preset switch says Loading only when its list is not cached", async (t) => {
    const h = await start(t, TOP_WITH_DEV);
    assert.equal(await h.handle.refresh(false), "ok");
    const before = h.notices.length;
    await command(h, "use dev");
    const loading = h.notices.slice(before).join("\n");
    assert.match(loading, /^Loading dev's models…$/m, loading);
    assert.doesNotMatch(loading, /reading the models from AWS|first start/, loading);
    await untilModel(h, "claude-haiku-5-5");

    // The top-level list was loaded at the start, so switching back needs no loading line.
    const beforeBack = h.notices.length;
    await command(h, "use top");
    const back = h.notices.slice(beforeBack).join("\n");
    assert.doesNotMatch(back, /Loading (dev's|the top-level) models/, back);
    assert.match(back, /Top-level settings are active: fixture · by tag/, back);
});

test("typed use and the menu print the same preset line", async (t) => {
    const typed = await start(t, TOP_WITH_DEV);
    await typed.handle.refresh(false);
    await loadPreset(typed, "jig-bedrock-dev");
    await command(typed, "use dev");
    assert.ok(typed.notices.includes("Preset dev is active: fixture · AWS-defined"), JSON.stringify(typed.notices));

    const menu = await start(t, TOP_WITH_DEV);
    await menu.handle.refresh(false);
    await loadPreset(menu, "jig-bedrock-dev");
    const answers: Array<string | undefined> = ["Presets", "dev — fixture · AWS-defined"];
    menu.ctx.ui.select = async (title: string, options: string[] = []) => {
        const wanted = answers.shift();
        if (wanted === undefined) return undefined;
        return options.find((option) => option === wanted || option.startsWith(wanted)) ?? wanted;
    };
    await command(menu, "");
    assert.ok(menu.notices.includes("Preset dev is active: fixture · AWS-defined"), JSON.stringify(menu.notices));
});

test("top is reserved and can never be a preset name", async (t) => {
    const loaded = loadConfig({
        raw: { regions: [REGION], presets: { top: { profile: "fixture" } } },
        env: {},
    });
    assert.equal(loaded.config, undefined);
    assert.match(loaded.error ?? "", /presets\.top is reserved for the top-level settings/);

    const h = await start(t, TOP_TAG);
    await command(h, "preset add top");
    assert.match(h.notices.join("\n"), /top is reserved for the top-level settings/);
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as { presets?: Record<string, unknown> };
    assert.equal(saved.presets?.top, undefined);
});
