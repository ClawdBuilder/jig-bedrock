/* biome-ignore-all lint/suspicious/noExplicitAny: Pi and provider doubles */
// `/bedrock use` selects a model; while a preset's models are still arriving it starts the discovery and changes nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const DEV_ARN = `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/dev-haiku`;
const MISSING_ARN = `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/not-listed`;

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
    presets: {
        dev: { profile: "dev", discovery: "list", profiles: [DEV_ARN] },
        missing: { profile: "missing", discovery: "list", profiles: [MISSING_ARN] },
    },
};

async function start(t: test.TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-use-preset-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const file = join(agent, "bedrock.json");
    writeFileSync(file, JSON.stringify(settings));
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
        events: { emit() {} },
        setModel: async (model: any) => {
            selected.push({ provider: model.provider, id: model.id });
            ctx.model = model;
            return true;
        },
    };
    const handle = await createBedrockProvider({
        env,
        listProfiles: async () => ["fixture", "dev", "missing"],
        backgroundRefresh: false,
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "fixture-secret" }),
    })(pi as never);
    assert.ok(handle);
    const command = async (args: string): Promise<void> => {
        await commands.get("bedrock")?.handler(args, ctx);
    };
    const until = async (check: () => boolean): Promise<void> => {
        for (let attempt = 0; attempt < 100 && !check(); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 10));
    };
    return { dir, agent, file, env, fake, providers, commands, notices, selected, ctx, handle, command, until };
}

test("use starts the refresh and changes nothing while the preset's models are loading", async (t) => {
    const h = await start(t);
    const before = readFileSync(h.file, "utf8");
    const calls = h.fake.calls.length;
    await h.command("use missing");
    assert.match(h.notices.join("\n"), /Loading missing's models…/, h.notices.join("\n"));
    assert.deepEqual(h.selected, [], "no model is selected before the list arrives");
    assert.equal(readFileSync(h.file, "utf8"), before, "the preset setting is not written");
    await h.until(() => h.fake.calls.length > calls);
    assert.ok(h.fake.calls.length > calls, "the discovery was started");
});

test("use selects the preset's model once its list is cached", async (t) => {
    const h = await start(t);
    const dev = [...h.providers].reverse().find((entry) => entry.id === "jig-bedrock-dev");
    assert.ok(dev);
    await dev.refreshModels({
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        publish: async () => true,
    });
    await h.command("use dev");
    assert.deepEqual(h.selected, [{ provider: "jig-bedrock-dev", id: "claude-haiku-5-5" }]);
    assert.equal(h.ctx.model.provider, "jig-bedrock-dev");
    assert.equal(
        (JSON.parse(readFileSync(h.file, "utf8")) as { preset?: string }).preset,
        "dev",
        "the chosen preset is the next session's default",
    );
    assert.match(h.notices.join("\n"), /Preset dev is active: dev · listed/);
});
