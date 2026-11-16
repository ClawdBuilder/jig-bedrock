import assert from "node:assert/strict";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const account = "123456789012";
const profileFor = (region: string): FakeAwsProfile => ({
    arn: `arn:aws:bedrock:${region}:${account}:application-inference-profile/team-${region}`,
    name: `team-${region}`,
    region,
    foundation: "anthropic.claude-sonnet-5-5",
    tags: { Team: "fixture", Active: "true" },
    kind: "application",
});

async function start(env: NodeJS.ProcessEnv, raw: Record<string, unknown>, fake: ReturnType<typeof fakeAwsHttp>) {
    const providers: any[] = [];
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, any>();
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
        config: {
            profile: "fixture",
            team: "fixture",
            tagKey: "Team",
            tagValue: "fixture",
            activeTagKey: "Active",
            activeTagValue: "true",
            regions: ["us-east-1"],
            agentDir: env.PI_CODING_AGENT_DIR,
            ssoLoginCommand: [],
            signInAtStart: false,
            ...raw,
        },
        catalog: undefined,
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" }),
        check: async () => ({
            node: { status: "ready", version: "22.19.0" },
            aws: { status: "ready", version: "2.34.46" },
            platform: "linux",
        }),
        backgroundRefresh: true,
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
    return { providers, commands, notices, hooks, ctx, handle };
}

test("a partial catalog retries at the next start and names the failed region", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-partial-retry-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(dir, "cache") };
    let fail = true;
    const fake = fakeAwsHttp({
        profiles: [profileFor("us-east-1"), profileFor("eu-west-1")],
        fail: (operation, region) =>
            fail && operation !== "sts" && region === "eu-west-1"
                ? { status: 500, body: JSON.stringify({ __type: "InternalServerException", message: "boom" }) }
                : undefined,
    });
    const first = await start(env, { regions: ["us-east-1", "eu-west-1"] }, fake);
    await first.handle.refresh(false);
    const firstModels = first.providers.at(-1)?.getModels?.() ?? [];
    assert.ok(
        !firstModels.some((model: any) => String(model.baseUrl).includes("eu-west-1")),
        JSON.stringify(firstModels),
    );
    const firstNotices = first.notices.join("\n");

    fail = false;
    const callsBefore = fake.calls.length;
    const second = await start(env, { regions: ["us-east-1", "eu-west-1"] }, fake);
    await second.handle.refresh(false);
    const models = second.providers.at(-1)?.getModels?.() ?? [];
    assert.ok(fake.calls.length > callsBefore, "the next start made AWS calls");
    assert.ok(
        models.some((model: any) => String(model.baseUrl).includes("eu-west-1")),
        "the next start registered the failed region's model",
    );
    assert.match(firstNotices, /eu-west-1 did not answer/);
});

test("an AWS_PROFILE provider with cached models stays configured after a failed refresh", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-auto-configured-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const cache = join(dir, "cache");
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: cache, AWS_PROFILE: "fixture" };
    const healthy = fakeAwsHttp({ profiles: [profileFor("us-east-1")] });
    const first = await start(env, { profile: undefined, regions: ["us-east-1"] }, healthy);
    await first.handle.refresh(false);
    assert.equal(first.providers.at(-1)?.getModels?.().length, 1);

    const folder = join(realpathSync(cache), "jig-bedrock");
    const files = readdirSync(folder).filter((name) => /^catalog-[0-9a-f]{12}\.json$/.test(name));
    assert.equal(files.length, 1, JSON.stringify(files));
    const file = join(folder, files[0] as string);
    const cached = JSON.parse(readFileSync(file, "utf8")) as { fetched_at: number };
    cached.fetched_at = Math.floor(Date.now() / 1000) - 2 * 86_400;
    writeFileSync(file, JSON.stringify(cached));
    chmodSync(file, 0o600);

    const failing = fakeAwsHttp({
        profiles: [profileFor("us-east-1")],
        fail: (operation) =>
            operation === "sts"
                ? {
                      status: 403,
                      body: JSON.stringify({
                          __type: "ExpiredToken",
                          message: "The security token included in the request is expired",
                      }),
                  }
                : undefined,
    });
    const second = await start(env, { profile: undefined, regions: ["us-east-1"] }, failing);
    const provider = second.providers.at(-1);
    assert.ok(provider.getModels().length > 0, "the cached models are registered");
    const status = await second.handle.refresh(false);
    assert.notEqual(status, "ok", "the refresh failed");
    const auth = await provider.auth.apiKey.resolve({ credential: undefined, signal: new AbortController().signal });
    assert.ok(auth !== undefined, "the provider stays configured");
    assert.equal(auth.env?.AWS_PROFILE, "fixture");
});

test("a tag search whose second tag matches nothing says to check the second tag", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-second-tag-hint-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(dir, "cache") };
    const fake = fakeAwsHttp({
        profiles: [{ ...profileFor("us-east-1"), tags: { Team: "fixture" } }],
    });
    const s = await start(env, { regions: ["us-east-1"] }, fake);
    await s.handle.refresh(false);
    assert.equal(s.providers.at(-1)?.getModels?.().length, 0);
    const text = s.notices.join("\n");
    assert.match(text, /No application inference profiles matched Team=fixture and Active=true/);
    assert.match(text, /second tag/);
});
