/* biome-ignore-all lint/suspicious/noExplicitAny: Pi and provider doubles */
// Design §5/§6/§8: `preset` opens a new session, and the two saved-default cases say one line and rewrite nothing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const DEV_ARN = `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/dev-haiku`;
const profiles: FakeAwsProfile[] = [
    {
        arn: `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-sonnet-5-5`,
        name: "System Sonnet",
        region: REGION,
        foundation: "anthropic.claude-sonnet-5-5",
        tags: {},
        kind: "system",
    },
    { arn: DEV_ARN, name: "Dev Haiku", region: REGION, foundation: "anthropic.claude-haiku-5-5", tags: {} },
];
const settings = {
    profile: "fixture",
    discovery: "aws-defined",
    regions: [REGION],
    preset: "dev",
    presets: { dev: { profile: "dev", discovery: "list", profiles: [DEV_ARN] } },
};

async function start(
    t: test.TestContext,
    options: { settingsFile?: Record<string, unknown>; raw?: Record<string, unknown> } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-initial-preset-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const raw = options.raw ?? settings;
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify(raw));
    if (options.settingsFile !== undefined)
        writeFileSync(join(agent, "settings.json"), JSON.stringify(options.settingsFile));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(dir, "cache") };
    const fake = fakeAwsHttp({ profiles, account: ACCOUNT });
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const commands = new Map<string, any>();
    const notices: string[] = [];
    const selected: Array<{ provider: string; id: string }> = [];
    const ctx: any = {
        hasUI: true,
        mode: "rpc",
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
        unregisterProvider() {},
        events: { emit() {} },
        setModel: async (model: any) => {
            selected.push({ provider: model.provider, id: model.id });
            ctx.model = model;
            return true;
        },
    };
    const handle = await createBedrockProvider({
        env,
        listProfiles: async () => ["fixture", "dev"],
        backgroundRefresh: false,
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "fixture-secret" }),
    })(pi as never);
    assert.ok(handle);
    const providerOf = (id: string): any => [...providers].reverse().find((entry) => entry.id === id);
    /** Prime one provider's list the way Pi's /model does, so the start can select from it. */
    const load = async (id: string): Promise<string[]> => {
        const provider = providerOf(id);
        assert.ok(provider, `${id} is registered`);
        await provider.refreshModels({
            allowNetwork: true,
            force: true,
            signal: new AbortController().signal,
            publish: async () => true,
        });
        return providerOf(id)
            ?.getModels?.()
            .map((model: { id: string }) => model.id);
    };
    const fire = async (name: string): Promise<void> => {
        for (const hook of hooks.get(name) ?? []) await hook({ reason: "startup" }, ctx);
    };
    const until = async (check: () => boolean): Promise<void> => {
        for (let attempt = 0; attempt < 100 && !check(); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 10));
    };
    return { dir, agent, env, hooks, providers, notices, selected, ctx, handle, load, fire, until };
}

test("a new session with nothing restored opens on the `preset` setting's model", async (t) => {
    const h = await start(t);
    assert.deepEqual(await h.load("jig-bedrock-dev"), ["claude-haiku-5-5"]);
    await h.load("jig-bedrock");
    await h.fire("session_start");
    await h.until(() => h.selected.length > 0);
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-haiku-5-5" }]);
    assert.equal(h.ctx.model.provider, "jig-bedrock-dev");
});

test("a saved default keeps the session off the `preset` setting", async (t) => {
    const h = await start(t, {
        settingsFile: { defaultProvider: "jig-bedrock", defaultModel: "claude-sonnet-5-5" },
    });
    await h.load("jig-bedrock-dev");
    await h.load("jig-bedrock");
    await h.fire("session_start");
    await h.until(() => h.selected.length > 0);
    // The session guard restores Pi's saved default (the plain provider); `preset` must not pull it to dev.
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock", id: "claude-sonnet-5-5" }]);
});

test("a preset's saved default is restored when Pi started on a fallback model", async (t) => {
    const h = await start(t, {
        settingsFile: { defaultProvider: "jig-bedrock-dev", defaultModel: "claude-haiku-5-5" },
    });
    await h.load("jig-bedrock-dev");
    await h.load("jig-bedrock");
    // Pi picked another provider's model because its availability snapshot did not yet know the preset; for a new
    // session it records that fallback as a model_change (sdk.ts), so the branch is not empty at session_start.
    h.ctx.model = { provider: "anthropic", id: "claude-sonnet-4-5" };
    h.ctx.sessionManager = {
        getSessionId: () => "test",
        getBranch: () => [{ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5" }],
    };
    await h.fire("session_start");
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-haiku-5-5" }]);
    assert.equal(h.ctx.model.provider, "jig-bedrock-dev");
    const input = h.hooks.get("input")?.[0];
    assert.ok(input, "the selection guard registers an input hook");
    const result = await input({ text: "hello", source: "interactive" }, h.ctx);
    assert.equal(result?.action, "continue", "a restored saved default does not block input");
});

test("a saved default naming a removed preset says so once, keeps the settings, and does not block input", async (t) => {
    const removed = { defaultProvider: "jig-bedrock-gone", defaultModel: "claude-haiku-5-5" };
    const h = await start(t, { raw: { profile: "fixture", regions: [REGION] }, settingsFile: removed });
    const before = readFileSync(join(h.agent, "settings.json"), "utf8");
    await h.fire("session_start");
    await h.fire("session_start");
    const lines = h.notices.filter((text) => text.includes("whose preset no longer exists"));
    assert.equal(lines.length, 1, JSON.stringify(h.notices));
    assert.match(lines[0] ?? "", /jig-bedrock-gone/);
    assert.equal(readFileSync(join(h.agent, "settings.json"), "utf8"), before, "Pi's settings are not rewritten");
    assert.ok(!existsSync(join(h.agent, ".bedrock-removed-preset.bak")));
    const guard = h.hooks.get("input")?.[0];
    assert.ok(guard, "the selection guard has an input hook");
    const result = (await guard({ text: "hi", source: "interactive" }, h.ctx)) as { action?: string };
    assert.equal(result.action, "continue", "a removed preset's saved default must not block input");
});

test("a plain saved default whose model is only in the `preset` gets the one-time upgrade line", async (t) => {
    const saved = { defaultProvider: "jig-bedrock", defaultModel: "claude-haiku-5-5" };
    const h = await start(t, { settingsFile: saved });
    assert.deepEqual(await h.load("jig-bedrock-dev"), ["claude-haiku-5-5"]);
    assert.deepEqual(await h.load("jig-bedrock"), ["claude-sonnet-5-5"]);
    const before = readFileSync(join(h.agent, "settings.json"), "utf8");
    await h.fire("session_start");
    await h.fire("session_start");
    const lines = h.notices.filter((text) => text.includes("/bedrock use dev"));
    assert.equal(lines.length, 1, JSON.stringify(h.notices));
    assert.match(lines[0] ?? "", /then Ctrl\+S in \/model/);
    assert.equal(readFileSync(join(h.agent, "settings.json"), "utf8"), before);
});
