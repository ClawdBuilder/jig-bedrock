/* biome-ignore-all lint/suspicious/noExplicitAny: fixtures stand in for Pi objects */
// Every preset is its own Pi provider: its own cached catalog, its own profile and credential, its own refusals.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { atomicCache } from "../src/cache.ts";
import { catalogFileFor } from "../src/cache-root.ts";
import { type Catalog, filterHash } from "../src/catalog.ts";
import { loadConfig, type ResolvedConfig } from "../src/config.ts";
import { jigBedrock } from "../src/index.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { isRefused } from "../src/refusals.ts";
import { fakeAwsHttp } from "./support/fake-aws-http.ts";
import { hostImport } from "./support/pi-host.ts";

const region = "us-east-1";
const account = "123456789012";
const appArn = (name: string) => `arn:aws:bedrock:${region}:${account}:application-inference-profile/${name}`;
const systemArn = `arn:aws:bedrock:${region}:${account}:inference-profile/global.anthropic.claude-sonnet-5-5`;
const refusalMessage = (arn: string) =>
    `AccessDeniedException: User: arn:aws:sts::${account}:assumed-role/ExampleRole/user is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: ${arn} because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action`;

function catalog(
    profile: string,
    mode: "system" | "explicit",
    entries: Array<{ arn: string; name: string; foundation: string; kind?: "application" | "system" }>,
    explicit: string[] = [],
): Catalog {
    return {
        schema: 1,
        mode,
        aws_profile: profile,
        account_id: account,
        regions: [region],
        fetched_at: Math.floor(Date.now() / 1000),
        ...(mode === "explicit"
            ? { filter_hash: filterHash({ mode: "explicit", profiles: explicit }) }
            : { filter_hash: filterHash({ mode: "system" }) }),
        profiles: entries.map((entry) => ({
            arn: entry.arn,
            profile_name: entry.name,
            foundation_model_id: entry.foundation,
            region,
            kind: entry.kind ?? "application",
        })),
    } as Catalog;
}

function scopeOf(config: ResolvedConfig): Parameters<typeof catalogFileFor>[0] {
    return {
        profile: config.profile,
        mode: config.mode,
        tagKey: config.tagKey,
        tagValue: config.tagValue,
        activeTagKey: config.activeTagKey,
        activeTagValue: config.activeTagValue,
        profiles: config.profiles,
        regions: config.regions,
    };
}

function seed(env: NodeJS.ProcessEnv, config: ResolvedConfig, value: Catalog): string {
    const file = catalogFileFor(scopeOf(config), env, true);
    atomicCache(file, value);
    return file;
}

function configFor(
    settings: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
    dir: string,
    preset?: string,
): ResolvedConfig {
    const result = loadConfig({
        raw: preset === undefined ? settings : { ...settings, preset },
        env,
        agentDir: dir,
        ...(preset === undefined ? {} : { presetOverride: preset }),
    });
    assert.ok(result.config, result.error);
    return result.config;
}

const threePresets = {
    profile: "fixture",
    discovery: "aws-defined",
    regions: [region],
    presets: {
        dev: { profile: "dev", discovery: "list", profiles: [appArn("dev-sonnet")] },
        personal: { profile: "personal", discovery: "list", profiles: [appArn("personal-haiku")] },
    },
};

function setup(t: test.TestContext, settings: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-preset-providers-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CACHE_HOME: join(dir, "cache") };
    writeFileSync(join(dir, "bedrock.json"), JSON.stringify(settings));
    const top = configFor(settings, env, dir);
    const dev = configFor(settings, env, dir, "dev");
    const personal = configFor(settings, env, dir, "personal");
    const profiles = [top.profile, dev.profile, personal.profile].filter((name): name is string => !!name);
    return { dir, env, top, dev, personal, profiles };
}

async function start(
    t: test.TestContext,
    settings: Record<string, unknown>,
    options: Record<string, unknown> = {},
    prepare?: (s: ReturnType<typeof setup>) => void,
) {
    const s = setup(t, settings);
    prepare?.(s);
    const providers: any[] = [];
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const notices: string[] = [];
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
    const handle = await createBedrockProvider({
        env: s.env,
        listProfiles: async () => s.profiles,
        backgroundRefresh: false,
        ...options,
    })(pi as never);
    assert.ok(handle);
    const provider = (id: string) => [...providers].reverse().find((entry) => entry.id === id);
    const modelIds = (id: string): string[] => (provider(id)?.getModels?.() ?? []).map((model: any) => model.id);
    return { ...s, providers, hooks, notices, handle, provider, modelIds };
}

const seedThree = (s: ReturnType<typeof setup>) => {
    seed(
        s.env,
        s.top,
        catalog("fixture", "system", [
            { arn: systemArn, name: "Global Sonnet", foundation: "anthropic.claude-sonnet-5-5", kind: "system" },
        ]),
    );
    seed(
        s.env,
        s.dev,
        catalog(
            "dev",
            "explicit",
            [{ arn: appArn("dev-sonnet"), name: "Dev Sonnet", foundation: "anthropic.claude-sonnet-5-5" }],
            [appArn("dev-sonnet")],
        ),
    );
    seed(
        s.env,
        s.personal,
        catalog(
            "personal",
            "explicit",
            [{ arn: appArn("personal-haiku"), name: "Personal Haiku", foundation: "anthropic.claude-haiku-5-5" }],
            [appArn("personal-haiku")],
        ),
    );
};

test("the top level and every preset are their own provider with their own models", async (t) => {
    const started = await start(t, threePresets, {}, seedThree);
    assert.deepEqual(started.providers.map((entry) => entry.id).sort(), [
        "jig-bedrock",
        "jig-bedrock-dev",
        "jig-bedrock-personal",
    ]);
    assert.equal(started.provider("jig-bedrock")?.name, "Amazon Bedrock (jig-bedrock)");
    assert.equal(started.provider("jig-bedrock-dev")?.name, "Amazon Bedrock (jig-bedrock-dev)");
    assert.equal(started.provider("jig-bedrock-personal")?.name, "Amazon Bedrock (jig-bedrock-personal)");
    assert.deepEqual(started.modelIds("jig-bedrock"), ["claude-sonnet-5-5"]);
    assert.deepEqual(started.modelIds("jig-bedrock-dev"), ["claude-sonnet-5-5"]);
    assert.deepEqual(started.modelIds("jig-bedrock-personal"), ["claude-haiku-5-5"]);
});

test("a preset's request is signed with that preset's own profile credentials", async (t) => {
    const signed: Array<{ url: string; authorization: string }> = [];
    const started = await start(
        t,
        threePresets,
        {
            credentials: async (profile?: string) => ({
                accessKeyId: `AKIA${(profile ?? "none").toUpperCase()}`,
                secretAccessKey: "fixture-secret",
            }),
            fetch: async (url: string | URL | Request, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                signed.push({ url: String(url), authorization: headers.get("authorization") ?? "" });
                return new Response(JSON.stringify({ message: "fixture answer" }), {
                    status: 400,
                    headers: { "content-type": "application/json" },
                });
            },
        },
        seedThree,
    );
    const ask = async (id: string) => {
        const provider = started.provider(id);
        const model = provider?.getModels?.()[0];
        assert.ok(model, `${id} has a model`);
        try {
            for await (const _event of provider.streamSimple(
                { ...model, provider: id },
                { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
                {},
            )) {
                // The signature is the assertion; the response is a fixture.
            }
        } catch {
            // The signature is the assertion; the response is a fixture.
        }
    };
    await ask("jig-bedrock-dev");
    await ask("jig-bedrock-personal");
    await ask("jig-bedrock");
    const credentials = signed.map((entry) => /Credential=([A-Z0-9]+)\//.exec(entry.authorization)?.[1]);
    assert.ok(credentials.includes("AKIADEV"), JSON.stringify(credentials));
    assert.ok(credentials.includes("AKIAPERSONAL"), JSON.stringify(credentials));
    assert.ok(credentials.includes("AKIAFIXTURE"), JSON.stringify(credentials));
});

test("a refusal hides the model only in the preset whose profile was refused", async (t) => {
    const arn = appArn("shared-opus");
    const settings = {
        profile: "fixture",
        discovery: "aws-defined",
        regions: [region],
        presets: {
            dev: { profile: "dev", discovery: "list", profiles: [arn] },
            personal: { profile: "personal", discovery: "list", profiles: [arn] },
        },
    };
    let env: NodeJS.ProcessEnv = {};
    const started = await start(
        t,
        settings,
        {
            credentials: async (profile?: string) => ({
                accessKeyId: `AKIA${(profile ?? "none").toUpperCase()}`,
                secretAccessKey: "fixture-secret",
            }),
            fetch: async () =>
                new Response(JSON.stringify({ message: refusalMessage(arn) }), {
                    status: 403,
                    headers: { "content-type": "application/json" },
                }),
        },
        (s) => {
            env = s.env;
            seed(
                s.env,
                s.top,
                catalog("fixture", "system", [
                    {
                        arn: systemArn,
                        name: "Global Sonnet",
                        foundation: "anthropic.claude-sonnet-5-5",
                        kind: "system",
                    },
                ]),
            );
            const shared = (profile: string) =>
                catalog(
                    profile,
                    "explicit",
                    [{ arn, name: "Shared Sonnet", foundation: "anthropic.claude-sonnet-5-5" }],
                    [arn],
                );
            seed(s.env, s.dev, shared("dev"));
            seed(s.env, s.personal, shared("personal"));
        },
    );
    const devProvider = started.provider("jig-bedrock-dev");
    const devModel = devProvider.getModels()[0];
    assert.ok(devModel);
    try {
        for await (const _event of devProvider.streamSimple(
            { ...devModel, provider: "jig-bedrock-dev" },
            { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
            {},
        )) {
            // The refusal is the assertion.
        }
    } catch {}
    assert.equal(isRefused(env, "dev", account, arn), true, "the dev profile's refusal is remembered");
    assert.equal(isRefused(env, "personal", account, arn), false, "the personal profile is untouched");
    assert.deepEqual(started.modelIds("jig-bedrock-dev"), [], "the refused model left the dev preset");
    assert.deepEqual(started.modelIds("jig-bedrock-personal"), ["claude-sonnet-5-5"], "and stays in the other preset");
});

test("a saved default for a preset is restored by Pi's own registry", async (t) => {
    const settings = {
        profile: "fixture",
        discovery: "aws-defined",
        regions: [region],
        presets: { dev: { profile: "dev", discovery: "list", profiles: [appArn("dev-opus")] } },
    };
    const s = setup(t, settings);
    seed(
        s.env,
        s.top,
        catalog("fixture", "system", [
            { arn: systemArn, name: "Global Sonnet", foundation: "anthropic.claude-sonnet-5-5", kind: "system" },
        ]),
    );
    seed(
        s.env,
        s.dev,
        catalog(
            "dev",
            "explicit",
            [{ arn: appArn("dev-opus"), name: "Dev Opus", foundation: "anthropic.claude-opus-5" }],
            [appArn("dev-opus")],
        ),
    );
    writeFileSync(
        join(s.dir, "settings.json"),
        JSON.stringify({ defaultProvider: "jig-bedrock-dev", defaultModel: "claude-opus-5" }),
    );
    const { createAgentSessionServices } = (await hostImport("@earendil-works/pi-coding-agent")) as any;
    const services = await createAgentSessionServices({
        cwd: s.dir,
        agentDir: s.dir,
        resourceLoaderOptions: {
            extensionFactories: [
                jigBedrock({ env: s.env, listProfiles: async () => s.profiles, backgroundRefresh: false }),
            ],
        },
    });
    const model = services.modelRuntime.getModel("jig-bedrock-dev", "claude-opus-5");
    assert.ok(model, "the saved default's model is registered under its preset's provider");
    // Pi writes configuredProviders from the last availability pass to start; a pass it supersedes returns first
    // (ModelRuntime.refresh), and on a slower scheduler the registration refreshes land after this call. Wait for
    // the settled snapshot /model is built from instead of reading the previous (pre-extension) pass's answer.
    const untilAvailable = async (): Promise<void> => {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (
                services.modelRuntime.hasConfiguredAuth("jig-bedrock-dev") &&
                services.modelRuntime.hasConfiguredAuth("jig-bedrock")
            )
                return;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };
    await untilAvailable();
    assert.equal(services.modelRuntime.hasConfiguredAuth("jig-bedrock-dev"), true);
    assert.equal(services.modelRuntime.hasConfiguredAuth("jig-bedrock"), true);
});

test("ten presets' catalog files all survive a discovery write", async (t) => {
    const presets: Record<string, unknown> = {};
    for (let n = 1; n <= 10; n++)
        presets[`team-${n}`] = {
            profile: "fixture",
            discovery: "tag",
            tagKey: "Team",
            tagValue: `team-${n}`,
            regions: [region],
        };
    const settings = {
        profile: "fixture",
        discovery: "tag",
        tagKey: "Team",
        tagValue: "fixture-team",
        regions: [region],
        presets,
    };
    let env: NodeJS.ProcessEnv = {};
    const fake = fakeAwsHttp();
    const started = await start(
        t,
        settings,
        {
            fetch: fake.fetch,
            discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "fixture-secret" }),
        },
        (s) => {
            env = s.env;
            const emptyFile = (config: ResolvedConfig): string => {
                const file = catalogFileFor(scopeOf(config), s.env, true);
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, "{}\n");
                return file;
            };
            const files = [emptyFile(s.top)];
            for (let n = 1; n <= 10; n++) files.push(emptyFile(configFor(settings, s.env, s.dir, `team-${n}`)));
            assert.equal(new Set(files).size, 11, "each scope has its own file");
        },
    );
    await started.handle.refresh(true);
    const kept = readdirSync(join(env.XDG_CACHE_HOME ?? "", "jig-bedrock")).filter((name) =>
        /^catalog-[0-9a-f]{12}\.json$/.test(name),
    );
    assert.equal(kept.length, 11, `kept ${kept.length} of 11 catalog files`);
});
