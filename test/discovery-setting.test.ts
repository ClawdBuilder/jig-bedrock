/* biome-ignore-all lint/suspicious/noExplicitAny: provider and Pi doubles */
/* biome-ignore-all lint/style/noNonNullAssertion: test assertions */
// The `discovery` setting names the way models are found: at the top level, in a preset, and through /login. Without it
// the way is inferred exactly as 0.6.2 did (the existing tests keep that), so an old bedrock.json keeps working.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, type ResolvedConfig } from "../src/config.ts";
import { jigBedrock } from "../src/index.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { fakeAwsHttp } from "./support/fake-aws-http.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const SYSTEM_ARN = `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-haiku-5-5`;
const APP_ARN = `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/team-app`;

/** One application inference profile (tag mode) and one AWS-defined profile (AWS-defined mode), with different models. */
function fakeAws() {
    return fakeAwsHttp({
        profiles: [
            {
                arn: APP_ARN,
                name: "team-app",
                region: REGION,
                foundation: "anthropic.claude-sonnet-5-5",
                tags: { Team: "fixture-team", Active: "true" },
                kind: "application",
            },
            {
                arn: SYSTEM_ARN,
                name: "System Haiku",
                region: REGION,
                foundation: "anthropic.claude-haiku-5-5",
                tags: {},
                kind: "system",
            },
        ],
    });
}

function folder(t: test.TestContext, raw: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-discovery-setting-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const file = join(agent, "bedrock.json");
    writeFileSync(file, JSON.stringify(raw));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(dir, "cache") };
    return { dir, agent, file, env };
}

function configFor(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): ResolvedConfig {
    const loaded = loadConfig({ raw, env, agentDir: env.PI_CODING_AGENT_DIR });
    assert.equal(loaded.error, undefined, loaded.error);
    assert.ok(loaded.config, "the settings load");
    return loaded.config;
}

/** The real provider with the fake AWS over its fetch, as Pi starts it. */
async function start(t: test.TestContext, raw: Record<string, unknown>) {
    const f = folder(t, raw);
    const fake = fakeAws();
    const config = configFor(raw, f.env);
    const providers: any[] = [];
    const commands = new Map<string, any>();
    const pi = {
        on() {},
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async () => true,
    };
    const handle = await createBedrockProvider({
        env: f.env,
        config,
        catalog: undefined,
        listProfiles: async () => ["fixture"],
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" }),
        backgroundRefresh: false,
    } as never)(pi as never);
    return { ...f, fake, config, providers, commands, handle };
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id).sort();
/** Refresh one preset's provider the way Pi's /model does; the plain provider's handle only refreshes the top level. */
async function loadPreset(s: { providers: any[] }, id: string): Promise<Array<{ id: string }>> {
    const provider = [...s.providers].reverse().find((entry) => entry.id === id);
    assert.ok(provider, `${id} is registered`);
    await provider.refreshModels({
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        publish: async () => true,
    });
    return (
        [...s.providers]
            .reverse()
            .find((entry) => entry.id === id)
            ?.getModels?.() ?? []
    );
}
const tagging = (calls: Array<{ target: string }>) => calls.filter((call) => call.target.includes("GetResources"));
const lists = (calls: Array<{ url: string }>) => calls.filter((call) => call.url.includes("/inference-profiles?"));

const presetWithTag = {
    profile: "top",
    tagKey: "Team",
    tagValue: "fixture-team",
    activeTagKey: "Active",
    activeTagValue: "true",
    regions: [REGION],
    presets: { dev: { profile: "fixture", discovery: "aws-defined" } },
    preset: "dev",
};

test("a preset that names aws-defined uses only its own mode, not the top-level tag", async (t) => {
    const s = await start(t, presetWithTag);
    assert.equal(s.config.discovery, "aws-defined");
    assert.equal(s.config.mode, "system");
    for (const key of ["tagKey", "tagValue", "activeTagKey", "activeTagValue", "profiles"] as const)
        assert.equal(s.config[key], undefined, `${key} is not inherited from the top level`);

    const dev = await loadPreset(s, "jig-bedrock-dev");
    assert.deepEqual(ids(dev), ["claude-haiku-5-5"], JSON.stringify(dev));
    assert.equal(tagging(s.fake.calls).length, 0, "AWS-defined discovery makes no tag call");
    assert.ok(lists(s.fake.calls).length > 0, "AWS-defined discovery lists the inference profiles");
});

test("a top-level discovery applies to a preset that does not name its own", async (t) => {
    const raw = {
        ...presetWithTag,
        discovery: "aws-defined",
        presets: { dev: { profile: "fixture" } },
    };
    const s = await start(t, raw);
    assert.equal(s.config.discovery, "aws-defined", "the top-level setting is inherited");
    assert.equal(s.config.mode, "system");
    assert.equal(s.config.tagKey, undefined);

    const dev = await loadPreset(s, "jig-bedrock-dev");
    assert.deepEqual(ids(dev), ["claude-haiku-5-5"], JSON.stringify(dev));
    assert.equal(tagging(s.fake.calls).length, 0);
});

test("a preset with its own tag mode ignores a top-level list", async (t) => {
    const raw = {
        profile: "top",
        profiles: [SYSTEM_ARN],
        regions: [REGION],
        presets: {
            team: {
                profile: "fixture",
                discovery: "tag",
                tagKey: "Team",
                tagValue: "fixture-team",
                activeTagKey: "Active",
                activeTagValue: "true",
            },
        },
        preset: "team",
    };
    const s = await start(t, raw);
    assert.equal(s.config.discovery, "tag");
    assert.equal(s.config.mode, "tag");
    assert.equal(s.config.profiles, undefined, "the top-level list is not inherited");
    assert.equal(s.config.tagKey, "Team");

    const team = await loadPreset(s, "jig-bedrock-team");
    assert.deepEqual(ids(team), ["claude-sonnet-5-5"], JSON.stringify(team));
    assert.ok(tagging(s.fake.calls).length > 0, "tag discovery lists the tagged profiles");
    assert.equal(lists(s.fake.calls).length, 0, "tag discovery does not list AWS-defined profiles");
});

test("discovery tag without tags and list without profiles are configuration errors with the fix", () => {
    const tag = loadConfig({ raw: { discovery: "tag", regions: [REGION] }, env: {} });
    assert.equal(tag.config, undefined);
    assert.match(tag.error ?? "", /discovery "tag" needs tagKey and tagValue/);
    assert.match(tag.error ?? "", /discovery "aws-defined"/, "the message names the way out");

    const list = loadConfig({ raw: { discovery: "list", regions: [REGION] }, env: {} });
    assert.equal(list.config, undefined);
    assert.match(list.error ?? "", /discovery "list" needs profiles/);
    assert.match(list.error ?? "", /discovery "aws-defined"/, "the message names the way out");

    const invalid = loadConfig({ raw: { discovery: "auto", regions: [REGION] }, env: {} });
    assert.equal(invalid.config, undefined);
    assert.match(invalid.error ?? "", /discovery must be "aws-defined", "tag" or "list"/);

    const preset = loadConfig({
        raw: {
            tagKey: "Team",
            tagValue: "fixture-team",
            regions: [REGION],
            presets: { dev: { profile: "fixture", discovery: "tag" } },
            preset: "dev",
        },
        env: {},
    });
    assert.equal(preset.config, undefined);
    assert.match(preset.error ?? "", /presets\.dev: discovery "tag" needs tagKey and tagValue/);
});

test("/login choosing AWS-defined under a preset writes discovery and the refresh lists AWS-defined models", async (t) => {
    const raw = {
        profile: "top",
        tagKey: "Team",
        tagValue: "fixture-team",
        activeTagKey: "Active",
        activeTagValue: "true",
        regions: [REGION],
        presets: { dev: { profile: "fixture" } },
        preset: "dev",
    };
    const f = folder(t, raw);
    const fake = fakeAws();
    const providers: any[] = [];
    const commands = new Map<string, any>();
    const pi = {
        on() {},
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async () => true,
    };
    await (
        jigBedrock({
            env: f.env,
            listProfiles: async () => ["fixture"],
            loginListProfiles: async () => ["fixture"],
            fetch: fake.fetch,
            discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" }),
            verifyProfile: async () => ({ ok: true }),
            check: async () =>
                ({
                    node: { status: "ready", version: "22.19.0" },
                    aws: { status: "ready", version: "2.34.46" },
                    platform: "linux",
                }) as never,
            backgroundRefresh: false,
        }) as never
    )(pi as never);
    // 0.7.0: /login on the preset's own provider edits that preset.
    const loginProvider = providers.find((entry) => entry?.id === "jig-bedrock-dev");
    assert.ok(loginProvider, "the preset's provider is registered");
    const notices: string[] = [];
    await loginProvider.auth.apiKey.login({
        signal: new AbortController().signal,
        prompt: async (prompt: any) => {
            if (prompt.type !== "select") return "";
            if (prompt.message?.includes("How do you sign in to AWS?")) return "existing";
            if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
            return "profile:fixture";
        },
        notify: (event: any) => notices.push(event.message ?? ""),
    });

    const saved = JSON.parse(readFileSync(f.file, "utf8")) as {
        discovery?: string;
        presets: Record<string, { discovery?: string }>;
    };
    assert.equal(saved.presets.dev?.discovery, "aws-defined", "the choice is written into the active preset");
    assert.equal(saved.discovery, undefined, "the top level is left alone");
    const registered = () => providers.at(-1);
    assert.deepEqual(
        registered()
            ?.getModels?.()
            .map((model: { id: string }) => model.id),
        ["claude-haiku-5-5"],
        notices.join("\n"),
    );
    const catalogs = readdirSync(join(f.env.XDG_CACHE_HOME as string, "jig-bedrock"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(f.env.XDG_CACHE_HOME as string, "jig-bedrock", name), "utf8")));
    assert.equal(catalogs.length, 1);
    assert.equal(catalogs[0]?.mode, "system", "the saved choice is what the refresh used");
    assert.equal(tagging(fake.calls).length, 0, "the login refresh made no tag call");

    // The next refresh after the dialog keeps the saved mode. 0.7.0 routes the command by the model in use: a session
    // on the preset's model is what makes /bedrock refresh read the preset the dialog just wrote.
    const devProvider = [...providers].reverse().find((entry) => entry?.id === "jig-bedrock-dev");
    const devModel = devProvider
        ?.getModels?.()
        .find((model: { provider: string }) => model.provider === "jig-bedrock-dev");
    assert.ok(devModel, "the preset's model is registered");
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        model: devModel,
        ui: { notify: (text: string) => notices.push(text) },
        sessionManager: { getSessionId: () => "test" },
        modelRegistry: { find: () => undefined },
    };
    await commands.get("bedrock")?.handler("refresh", ctx);
    assert.deepEqual(
        registered()
            ?.getModels?.()
            .map((model: { id: string }) => model.id),
        ["claude-haiku-5-5"],
        notices.join("\n"),
    );
    assert.equal(tagging(fake.calls).length, 0);
});

test("/bedrock set discovery aws-defined saves and reloads the models at once", async (t) => {
    const raw = {
        profile: "top",
        tagKey: "Team",
        tagValue: "fixture-team",
        activeTagKey: "Active",
        activeTagValue: "true",
        regions: [REGION],
    };
    const s = await start(t, raw);
    assert.equal(await s.handle.refresh(false), "ok");
    assert.deepEqual(ids(s.handle.models), ["claude-sonnet-5-5"], JSON.stringify(s.handle.models));
    assert.ok(tagging(s.fake.calls).length > 0);
    const taggingBefore = tagging(s.fake.calls).length;
    const listsBefore = lists(s.fake.calls).length;

    const notices: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        model: undefined,
        ui: { notify: (text: string) => notices.push(text) },
        sessionManager: { getSessionId: () => "test" },
        modelRegistry: { find: () => undefined },
    };
    await s.commands.get("bedrock")?.handler("set discovery aws-defined", ctx);

    const saved = JSON.parse(readFileSync(s.file, "utf8")) as { discovery?: string };
    assert.equal(saved.discovery, "aws-defined");
    assert.match(notices.join("\n"), /Saved\. Loading models for the new settings/);
    assert.deepEqual(ids(s.handle.models), ["claude-haiku-5-5"], notices.join("\n"));
    assert.equal(tagging(s.fake.calls).length, taggingBefore, "the path after the save makes no tag call");
    assert.ok(lists(s.fake.calls).length > listsBefore, "the path after the save lists AWS-defined profiles");
});
