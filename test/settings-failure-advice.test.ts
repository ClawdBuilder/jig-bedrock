import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const account = "123456789012";
const profile = (name: string): FakeAwsProfile => ({
    arn: `arn:aws:bedrock:us-east-1:${account}:application-inference-profile/${name}`,
    name,
    region: "us-east-1",
    foundation: "anthropic.claude-sonnet-5-5",
    tags: { Team: "fixture", Active: "true" },
    kind: "application",
});
const raw = {
    profile: "fixture",
    tagKey: "Team",
    tagValue: "fixture",
    activeTagKey: "Active",
    activeTagValue: "true",
    regions: ["us-east-1"],
};

async function start(t: test.TestContext, fake: ReturnType<typeof fakeAwsHttp>) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-settings-failure-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const env = {
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        XDG_CACHE_HOME: join(dir, "cache"),
        LANG: "C.UTF-8",
    };
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify(raw));
    const resolved = loadConfig({ raw, env, agentDir: agent });
    assert.ok(resolved.config);
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, any>();
    const providers: any[] = [];
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
        setModel: async () => true,
    };
    const handle = await createBedrockProvider({
        env,
        config: resolved.config,
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" }),
        verifyProfile: async () => ({ ok: true }),
        backgroundRefresh: true,
    } as never)(pi as never);
    const notices: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        model: undefined,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: { find: () => undefined },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    await handle.refresh(true);
    assert.equal(providers.at(-1)?.getModels?.().length, 2);
    notices.length = 0;
    return { dir, env, commands, notices, ctx, providers, handle };
}

test("a settings change that matches no tag says why the models left", async (t) => {
    const fake = fakeAwsHttp({ profiles: [profile("a"), profile("b")] });
    const s = await start(t, fake);
    await s.commands.get("bedrock").handler("set tagValue other", s.ctx);
    const text = s.notices.join("\n");
    assert.match(text, /Bedrock: 0 models in \/model \(2 left\)\./);
    assert.match(text, /No application inference profiles matched Team=other and Active=true/);
    assert.match(text, /Next: fix the tag or list in \/bedrock settings/);
    assert.doesNotMatch(text, /unexpected answer/);
    assert.equal(s.providers.at(-1)?.getModels?.().length, 0);
});

test("a settings change that AWS refuses says why the models left", async (t) => {
    let fail = false;
    const fake = fakeAwsHttp({
        profiles: [profile("a"), profile("b")],
        fail: (operation) =>
            fail && operation === "tagging"
                ? { status: 500, body: JSON.stringify({ __type: "InternalServerException", message: "boom" }) }
                : undefined,
    });
    const s = await start(t, fake);
    fail = true;
    await s.commands.get("bedrock").handler("set tagValue other", s.ctx);
    const text = s.notices.join("\n");
    assert.match(text, /Bedrock: 0 models in \/model \(2 left\)\./);
    assert.match(text, /Could not list tagged inference profiles: AWS had a problem on its side/);
    assert.match(text, /Next: AWS had a problem on its side; try again later/);
    assert.doesNotMatch(text, /unexpected answer/);
    assert.equal(s.providers.at(-1)?.getModels?.().length, 0);
});
