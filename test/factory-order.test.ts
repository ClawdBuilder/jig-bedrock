// The saved catalog is turned into models at the factory, before session_start. Its order must be the same
// Sonnet-first order the refresh path uses, or Pi starts on AWS's first profile.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicCache } from "../src/cache.ts";
import { catalogFileFor } from "../src/cache-root.ts";
import { filterHash, readCatalog } from "../src/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { isRefused, rememberRefusal } from "../src/refusals.ts";

const rows = [
    "claude-opus-5",
    "claude-sonnet-5-5",
    "gpt-6-luna",
    "claude-opus-4-8",
    "nova-2-lite",
    "claude-haiku-5-5",
    "gpt-6-1-sol",
    "nova-pro",
    "claude-sonnet-4-6",
    "claude-opus-5-5",
    "claude-haiku-4-5",
    "gpt-6-1-terra",
    "claude-sonnet-5",
];
const foundation = (name: string): string =>
    name.startsWith("gpt") ? `openai.${name}` : name.startsWith("nova") ? `amazon.${name}-v1:0` : `anthropic.${name}`;
const region = "us-east-1";
const account = "123456789012";
const catalog = {
    schema: 1 as const,
    mode: "tag" as const,
    aws_profile: "fixture",
    account_id: account,
    regions: [region],
    fetched_at: Math.floor(Date.now() / 1000),
    filter_hash: filterHash({ mode: "tag", tagKey: "Team", tagValue: "fixture-team" }),
    profiles: rows.map((name, n) => ({
        arn: `arn:aws:bedrock:${region}:${account}:application-inference-profile/team-${n}`,
        profile_name: `team-${name}`,
        foundation_model_id: foundation(name),
        region,
        kind: "application" as const,
    })),
};

function home(): { dir: string; env: NodeJS.ProcessEnv; config: ReturnType<typeof loadConfig> } {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-order-"));
    const settings = { profile: "fixture", tagKey: "Team", tagValue: "fixture-team", regions: [region] };
    writeFileSync(join(dir, "bedrock.json"), JSON.stringify(settings));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CACHE_HOME: join(dir, "cache") };
    const file = catalogFileFor(
        { profile: "fixture", mode: "tag", tagKey: "Team", tagValue: "fixture-team", regions: [region] },
        env,
        true,
    );
    atomicCache(file, catalog);
    const read = readCatalog(file, {
        profile: "fixture",
        mode: "tag",
        tagKey: "Team",
        tagValue: "fixture-team",
        regions: [region],
    });
    assert.ok(read, `cache not readable: ${file}`);
    return { dir, env, config: loadConfig({ raw: settings, env, agentDir: dir }) };
}

function harness() {
    const providers: any[] = [];
    const commands = new Map<string, any>();
    return {
        providers,
        commands,
        pi: {
            on() {},
            registerProvider(provider: any) {
                providers.push(provider);
            },
            registerCommand(name: string, value: any) {
                commands.set(name, value);
            },
            events: { emit() {} },
            setModel: () => false,
        },
    };
}

async function start(t: test.TestContext, before?: (env: NodeJS.ProcessEnv) => void) {
    const h = home();
    t.after(() => rmSync(h.dir, { recursive: true, force: true }));
    assert.ok(h.config.config);
    before?.(h.env);
    const p = harness();
    const handle = await createBedrockProvider({
        env: h.env,
        config: h.config.config,
        listProfiles: async () => ["fixture"],
        backgroundRefresh: false,
    })(p.pi as never);
    assert.ok(handle);
    const provider = p.providers.find((entry) => entry.id === "jig-bedrock");
    assert.ok(provider);
    return { ...h, provider, providers: p.providers, handle, commands: p.commands, pi: p.pi };
}

const models = (provider: any): Array<{ id: string; foundationModelId: string }> =>
    provider.getModels?.() ?? (provider.models as Array<{ id: string; foundationModelId: string }>);

test("a saved tag catalog registers Sonnet first at the factory", async (t) => {
    const s = await start(t);
    const list = models(s.provider);
    assert.ok(list.length > 0, JSON.stringify(s.handle.models));
    assert.match(list[0]?.id ?? "", /sonnet-5-5/);
    const claude = list.filter((model) => /claude|sonnet|opus|haiku/.test(model.id));
    const other = list.filter((model) => !/claude|sonnet|opus|haiku/.test(model.id));
    if (other.length > 0) {
        const lastClaude = list.indexOf(claude.at(-1) as never);
        const firstOther = list.indexOf(other[0] as never);
        assert.ok(lastClaude < firstOther, "Claude models come before gpt/nova");
    }
});

test("a refresh of the same catalog keeps Sonnet first", async (t) => {
    const s = await start(t);
    await s.handle.refresh(true);
    assert.match(models(s.provider)[0]?.id ?? "", /sonnet-5-5/);
});

test("a preset switch to an AWS-order saved catalog registers Sonnet first", async (t) => {
    const s = await start(t);
    const aws = { ...catalog, aws_profile: "personal" };
    const file = catalogFileFor(
        { profile: "personal", mode: "tag", tagKey: "Team", tagValue: "fixture-team", regions: [region] },
        s.env,
        true,
    );
    atomicCache(file, aws);
    writeFileSync(
        join(s.dir, "bedrock.json"),
        JSON.stringify({
            profile: "fixture",
            tagKey: "Team",
            tagValue: "fixture-team",
            regions: [region],
            presets: { personal: { profile: "personal" } },
        }),
    );
    await s.commands.get("bedrock")?.handler("use personal", {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify() {}, setStatus() {} },
        sessionManager: { getSessionId: () => "s" },
    });
    assert.match(models(s.provider)[0]?.id ?? "", /sonnet-5-5/);
});

test("a remembered refusal is hidden at the factory", async (t) => {
    const s = await start(t, (env) =>
        rememberRefusal(env, "fixture", account, catalog.profiles[0]!.arn, "claude-opus-5"),
    );
    assert.ok(!models(s.provider).some((model) => model.id === "claude-opus-5"));
});
