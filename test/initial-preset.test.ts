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
    options: {
        settingsFile?: Record<string, unknown>;
        raw?: Record<string, unknown>;
        /** The fake AWS profiles, for a test whose two runtimes see different accounts or profiles. */
        profiles?: FakeAwsProfile[];
        /** Start every runtime's discovery at session_start, instead of leaving it to the test. */
        background?: boolean;
        /** Hold each fake AWS response, so a discovery lands after session_start has passed the guard. */
        discoveryDelayMs?: number;
        /** Hold only the responses whose request body names this string, e.g. one preset's ARN. */
        delayIncludes?: string;
        /** Pi's availability gate: setModel refuses a provider until its availability pass marks it configured. */
        authGate?: boolean;
    } = {},
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
    const fake = fakeAwsHttp({ profiles: options.profiles ?? profiles, account: ACCOUNT });
    const delay = options.discoveryDelayMs;
    const fetchWithDelay =
        delay === undefined
            ? fake.fetch
            : async (input: any, init: any) => {
                  const body = typeof init?.body === "string" ? init.body : "";
                  if (options.delayIncludes === undefined || body.includes(options.delayIncludes))
                      await new Promise((resolve) => setTimeout(resolve, delay));
                  return fake.fetch(input, init);
              };
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const commands = new Map<string, any>();
    const notices: string[] = [];
    const selected: Array<{ provider: string; id: string }> = [];
    // With authGate, nothing is configured until Pi's availability pass runs (the fresh home at first start).
    const configured = new Set<string>();
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
            if (options.authGate === true && !configured.has(model.provider)) return false;
            selected.push({ provider: model.provider, id: model.id });
            ctx.model = model;
            return true;
        },
    };
    const handle = await createBedrockProvider({
        env,
        listProfiles: async () => ["fixture", "dev"],
        backgroundRefresh: options.background === true,
        fetch: fetchWithDelay,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "fixture-secret" }),
    })(pi as never);
    assert.ok(handle);
    if (options.authGate === true)
        // Pi's registry is honest, and its availability pass has not run yet: setModel refuses a provider until the
        // pass marks it configured (agent-session's extension setModel returns false, without an error).
        ctx.modelRegistry = {
            ...honestRegistry(providers),
            hasConfiguredAuth: (model: any) => configured.has(model.provider),
            refresh: async () => {
                for (const provider of providers) configured.add(provider.id);
                return { aborted: false, errors: new Map() };
            },
        };
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

/** The model Pi started on reaches session_start as the branch's model change (sdk.ts), before our providers exist. */
function piStartedOn(ctx: any, provider: string, id: string): void {
    ctx.model = { provider, id };
    ctx.sessionManager = {
        getSessionId: () => "test",
        getBranch: () => [{ type: "model_change", provider, modelId: id }],
    };
}

/** Pi's registry: a model is found only when the provider that registered it lists that id. */
function honestRegistry(providers: any[]) {
    return {
        find: (provider: string, id: string) => {
            const registered = [...providers].reverse().find((entry) => entry.id === provider);
            const model = registered?.getModels?.().find((entry: { id: string }) => entry.id === id);
            return model === undefined ? undefined : { ...model, provider };
        },
    };
}

/** How many models the plain provider has registered so far. */
function plainModelCount(h: { providers: any[] }): number {
    return (
        [...h.providers]
            .reverse()
            .find((entry) => entry.id === "jig-bedrock")
            ?.getModels?.().length ?? 0
    );
}

/**
 * A fresh agent home with only `jig-bedrock` and `jig-bedrock-dev`: neither has a cached list, Pi starts on its own
 * unknown model, and a new session's branch is empty. The saved default is dev's sonnet, which only dev lists.
 */
async function freshStartWithNoModel(
    t: test.TestContext,
    options: { background?: boolean; delayDevMs?: number; authGate?: boolean } = {},
) {
    const devArn = `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/dev-sonnet`;
    const freshProfiles: FakeAwsProfile[] = [
        {
            arn: `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-haiku-5-5`,
            name: "System Haiku",
            region: REGION,
            foundation: "anthropic.claude-haiku-5-5",
            tags: {},
            kind: "system",
        },
        { arn: devArn, name: "Dev Sonnet", region: REGION, foundation: "anthropic.claude-sonnet-5-5", tags: {} },
    ];
    const h = await start(t, {
        raw: {
            profile: "fixture",
            discovery: "aws-defined",
            regions: [REGION],
            preset: "dev",
            presets: { dev: { profile: "dev", discovery: "list", profiles: [devArn] } },
        },
        profiles: freshProfiles,
        settingsFile: { defaultProvider: "jig-bedrock-dev", defaultModel: "claude-sonnet-5-5" },
        background: options.background === true,
        authGate: options.authGate === true,
        ...(options.delayDevMs === undefined ? {} : { discoveryDelayMs: options.delayDevMs, delayIncludes: devArn }),
    });
    h.ctx.model = { provider: "unknown", id: "unknown", api: "unknown" };
    h.ctx.sessionManager = { getSessionId: () => "test", getBranch: () => [] };
    if (options.authGate !== true) h.ctx.modelRegistry = honestRegistry(h.providers);
    return h;
}

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

test("an explicit --model is never replaced by a preset's saved default", async (t) => {
    const h = await start(t, {
        settingsFile: { defaultProvider: "jig-bedrock-dev", defaultModel: "claude-haiku-5-5" },
    });
    await h.load("jig-bedrock-dev");
    await h.load("jig-bedrock");
    piStartedOn(h.ctx, "anthropic", "claude-sonnet-4-5");
    const before = process.argv;
    process.argv = [...before, "--model", "anthropic/claude-sonnet-4-5"];
    t.after(() => {
        process.argv = before;
    });
    await h.fire("session_start");
    assert.deepEqual(h.selected, [], "the saved default does not replace the explicit model");
    assert.equal(h.ctx.model.provider, "anthropic");
    assert.equal(h.ctx.model.id, "claude-sonnet-4-5");
    const input = h.hooks.get("input")?.[0];
    assert.ok(input, "the selection guard registers an input hook");
    const result = await input({ text: "hello", source: "interactive" }, h.ctx);
    assert.equal(result?.action, "continue", "an explicit model outside the catalog does not block input");
});

test("an explicit --provider is never replaced by a preset's saved default", async (t) => {
    const h = await start(t, {
        settingsFile: { defaultProvider: "jig-bedrock-dev", defaultModel: "claude-haiku-5-5" },
    });
    await h.load("jig-bedrock-dev");
    await h.load("jig-bedrock");
    piStartedOn(h.ctx, "anthropic", "claude-sonnet-4-5");
    const before = process.argv;
    process.argv = [...before, "--provider", "anthropic"];
    t.after(() => {
        process.argv = before;
    });
    await h.fire("session_start");
    assert.deepEqual(h.selected, [], "the saved default does not replace the explicit provider");
    assert.equal(h.ctx.model.provider, "anthropic");
    assert.equal(h.ctx.model.id, "claude-sonnet-4-5");
});

test("a preset's saved default is restored when its models arrive after a fallback start", async (t) => {
    const h = await start(t, {
        settingsFile: { defaultProvider: "jig-bedrock-dev", defaultModel: "claude-haiku-5-5" },
        background: true,
        discoveryDelayMs: 50,
    });
    // Pi started on another provider's model and recorded that fallback as the branch's model_change; dev's list is
    // not cached, so its discovery is still running when the guard first looks at the saved default.
    piStartedOn(h.ctx, "anthropic", "claude-sonnet-4-5");
    // Pi's registry is honest: a provider's model is found only after that provider registered it.
    h.ctx.modelRegistry = honestRegistry(h.providers);
    await h.fire("session_start");
    assert.deepEqual(h.selected, [], "nothing is selected before the preset's models arrive");
    await h.until(() => h.selected.length > 0);
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-haiku-5-5" }]);
    assert.equal(h.ctx.model.provider, "jig-bedrock-dev");
    assert.equal(h.ctx.model.id, "claude-haiku-5-5");
    assert.ok(
        h.notices.some((text) => text === "Bedrock: restored claude-haiku-5-5 (jig-bedrock-dev)."),
        JSON.stringify(h.notices),
    );
    const input = h.hooks.get("input")?.[0];
    assert.ok(input, "the selection guard registers an input hook");
    const result = await input({ text: "hello", source: "interactive" }, h.ctx);
    assert.equal(result?.action, "continue", "a restored saved default does not block input");
});

test("a preset's saved default is restored on a fresh start with no model", async (t) => {
    const h = await freshStartWithNoModel(t);
    await h.fire("session_start");
    // The primary's list arrives first, while the preset's own list is still missing.
    assert.deepEqual(await h.load("jig-bedrock"), ["claude-haiku-5-5"]);
    assert.deepEqual(h.selected, [], "the primary's list does not decide the preset's saved default");
    // Then dev's list arrives: the saved default must be selected through dev.
    assert.deepEqual(await h.load("jig-bedrock-dev"), ["claude-sonnet-5-5"]);
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-sonnet-5-5" }]);
    assert.equal(h.ctx.model.provider, "jig-bedrock-dev");
    assert.equal(h.ctx.model.id, "claude-sonnet-5-5");
    assert.ok(
        h.notices.some((text) => text === "Bedrock: restored claude-sonnet-5-5 (jig-bedrock-dev)."),
        JSON.stringify(h.notices),
    );
    const input = h.hooks.get("input")?.[0];
    assert.ok(input, "the selection guard registers an input hook");
    const result = await input({ text: "hello", source: "interactive" }, h.ctx);
    assert.equal(result?.action, "continue", "a restored saved default does not block input");
});

test("the same fresh start restores its saved default when the preset's list arrives first", async (t) => {
    const h = await freshStartWithNoModel(t);
    await h.fire("session_start");
    assert.deepEqual(await h.load("jig-bedrock-dev"), ["claude-sonnet-5-5"]);
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-sonnet-5-5" }]);
    // The primary's late list neither replaces the restored model nor clears the restored state.
    assert.deepEqual(await h.load("jig-bedrock"), ["claude-haiku-5-5"]);
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-sonnet-5-5" }]);
    const input = h.hooks.get("input")?.[0];
    assert.ok(input, "the selection guard registers an input hook");
    const result = await input({ text: "hello", source: "interactive" }, h.ctx);
    assert.equal(result?.action, "continue", "a restored saved default does not block input");
});

test("a preset's saved default is restored while Pi's availability is still settling", async (t) => {
    // Pi's extension setModel returns false, without an error, for a provider its availability pass has not marked
    // configured; the registration a late refresh makes starts that pass. The guard must wait for it and ask again.
    const h = await freshStartWithNoModel(t, { authGate: true });
    await h.fire("session_start");
    // The primary's list arrives first; its provider is not the saved default's.
    assert.deepEqual(await h.load("jig-bedrock"), ["claude-haiku-5-5"]);
    assert.deepEqual(h.selected, [], "the primary's list does not decide the preset's saved default");
    // Dev's list arrives while Pi has not marked dev configured: the first setModel is refused, so the guard waits
    // for Pi's availability pass and asks again.
    assert.deepEqual(await h.load("jig-bedrock-dev"), ["claude-sonnet-5-5"]);
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-sonnet-5-5" }]);
    assert.equal(h.ctx.model.provider, "jig-bedrock-dev");
    assert.equal(h.ctx.model.id, "claude-sonnet-5-5");
    assert.ok(
        h.notices.some((text) => text === "Bedrock: restored claude-sonnet-5-5 (jig-bedrock-dev)."),
        JSON.stringify(h.notices),
    );
    const input = h.hooks.get("input")?.[0];
    assert.ok(input, "the selection guard registers an input hook");
    const result = await input({ text: "hello", source: "interactive" }, h.ctx);
    assert.equal(result?.action, "continue", "a restored saved default does not block input");
});

test("a preset's saved default is restored when both runtimes refresh in the background", async (t) => {
    const h = await freshStartWithNoModel(t, { background: true, delayDevMs: 100 });
    await h.fire("session_start");
    // Both runtimes discover in the background; dev's requests are held. The preset's default must be selected, and
    // the primary's later list must neither replace it nor clear it.
    await h.until(() => h.selected.length > 0 && plainModelCount(h) > 0);
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-sonnet-5-5" }]);
    assert.equal(h.ctx.model.provider, "jig-bedrock-dev");
    assert.equal(h.ctx.model.id, "claude-sonnet-5-5");
    assert.ok(
        h.notices.some((text) => text === "Bedrock: restored claude-sonnet-5-5 (jig-bedrock-dev)."),
        JSON.stringify(h.notices),
    );
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
