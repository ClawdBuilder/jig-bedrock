/* biome-ignore-all lint/suspicious/noExplicitAny: Pi and provider doubles */
// The model in use decides the scope: the footer, the spend record, /bedrock and the budget follow its preset (design §4).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { appendReply, monthLabel, monthOf, readMonth, type SpendReply } from "../src/spend.ts";
import { type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const appArn = (name: string) => `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/${name}`;
const systemArn = `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-sonnet-5-5`;
const DEV_ARN = appArn("dev-haiku");
const PERSONAL_ARN = appArn("personal-opus");

const profiles: FakeAwsProfile[] = [
    {
        arn: systemArn,
        name: "System Sonnet",
        region: REGION,
        foundation: "anthropic.claude-sonnet-5-5",
        tags: {},
        kind: "system",
    },
    { arn: DEV_ARN, name: "Dev Haiku", region: REGION, foundation: "anthropic.claude-haiku-5-5", tags: {} },
    { arn: PERSONAL_ARN, name: "Personal Opus", region: REGION, foundation: "anthropic.claude-opus-5", tags: {} },
];

const settings = {
    profile: "fixture",
    discovery: "aws-defined",
    regions: [REGION],
    monthlyBudgetUsd: 100,
    presets: {
        dev: { profile: "dev", discovery: "list", profiles: [DEV_ARN], monthlyBudgetUsd: 100 },
        personal: { profile: "personal", discovery: "list", profiles: [PERSONAL_ARN], monthlyBudgetUsd: 100 },
    },
};

const month = (): string => monthLabel(monthOf(Date.now()));
const reply = (costUsd: number, preset?: string): SpendReply => ({
    type: "reply",
    ...(preset === undefined ? {} : { preset }),
    at: new Date().toISOString(),
    session: "s",
    model: "claude-sonnet-5-5",
    region: REGION,
    route: "messages",
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd,
    priced: true,
});

async function start(
    t: test.TestContext,
    options: { model?: unknown; settingsFile?: Record<string, unknown>; spend?: Array<[number, string?]> } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-model-focus-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const env = {
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        XDG_CACHE_HOME: join(dir, "cache"),
        XDG_STATE_HOME: join(dir, "state"),
    };
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify(settings));
    if (options.settingsFile !== undefined)
        writeFileSync(join(agent, "settings.json"), JSON.stringify(options.settingsFile));
    for (const [cost, preset] of options.spend ?? []) appendReply(env, reply(cost, preset));
    const fake = fakeAwsHttp({ profiles, account: ACCOUNT });
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const commands = new Map<string, any>();
    const notices: string[] = [];
    const statuses: Array<string | undefined> = [];
    const ctx: any = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        model: options.model,
        ui: {
            notify: (text: string) => notices.push(text),
            setStatus: (_key: string, text: string | undefined) => statuses.push(text),
        },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
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
        listProfiles: async () => ["fixture", "dev", "personal"],
        backgroundRefresh: false,
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "fixture-secret" }),
    })(pi as never);
    assert.ok(handle);
    const providerOf = (id: string): any => [...providers].reverse().find((entry) => entry.id === id);
    const load = async (id: string): Promise<any> => {
        const provider = providerOf(id);
        assert.ok(provider, `${id} is registered`);
        await provider.refreshModels({
            allowNetwork: true,
            force: true,
            signal: new AbortController().signal,
            publish: async () => true,
        });
        const model = providerOf(id)
            ?.getModels?.()
            .find((entry: any) => entry.provider === id);
        assert.ok(model, `${id} has a model`);
        return model;
    };
    const fire = async (name: string, event: unknown): Promise<void> => {
        for (const hook of hooks.get(name) ?? []) await hook(event, ctx);
    };
    const command = async (args: string): Promise<void> => {
        await commands.get("bedrock")?.handler(args, ctx);
    };
    const until = async (check: () => boolean): Promise<void> => {
        for (let attempt = 0; attempt < 100 && !check(); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 10));
    };
    return { dir, agent, env, hooks, providers, commands, notices, statuses, ctx, handle, load, fire, command, until };
}

/** The last block a command printed under `title`. */
const block = (h: Awaited<ReturnType<typeof start>>, title: string): string =>
    [...h.notices].reverse().find((text) => text.startsWith(title)) ?? "";
const savedSettings = (h: Awaited<ReturnType<typeof start>>): Record<string, any> =>
    JSON.parse(readFileSync(join(h.agent, "bedrock.json"), "utf8"));

test("selecting a preset model moves the footer to its spend, and a top model moves it back", async (t) => {
    // $2 before presets (counted by every scope), $5 under dev, $11 under personal.
    const h = await start(t, { spend: [[2], [5, "dev"], [11, "personal"]] });
    const dev = await h.load("jig-bedrock-dev");
    const top = await h.load("jig-bedrock");
    await h.fire("session_start", { reason: "startup" });
    h.ctx.model = dev;
    await h.fire("model_select", { source: "set", model: dev });
    assert.equal(h.statuses.at(-1), `dev · ${month().split(" ")[0]} $7.00 / $100`, JSON.stringify(h.statuses));
    h.ctx.model = top;
    await h.fire("model_select", { source: "set", model: top });
    assert.equal(h.statuses.at(-1), `${month().split(" ")[0]} $2.00 / $100`, JSON.stringify(h.statuses));
    const plain = { provider: "amazon-bedrock", id: "claude-sonnet-5-5" };
    h.ctx.model = plain;
    await h.fire("model_select", { source: "set", model: plain });
    assert.equal(h.statuses.at(-1), undefined, "another provider's model clears the footer");
});

test("a reply on a preset model records the spend under that preset", async (t) => {
    const h = await start(t);
    const dev = await h.load("jig-bedrock-dev");
    h.ctx.model = dev;
    const answer = (provider: string) => ({
        role: "assistant",
        provider,
        api: "anthropic-messages",
        model: "claude-haiku-5-5",
        stopReason: "stop",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 12.4 } },
    });
    await h.fire("message_end", { message: answer("jig-bedrock-dev") });
    await h.fire("message_end", { message: answer("jig-bedrock") });
    const lines = readMonth(h.env, monthOf(Date.now()));
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.deepEqual(
        lines.map((line) => [line.preset, line.costUsd]),
        [
            ["dev", 12.4],
            [undefined, 12.4],
        ],
    );
    assert.match(h.statuses.at(-1) ?? "", /^dev · /, "the reply was on the dev model, so its footer moved");
});

test("/bedrock status and set act on the model's preset, else the top level", async (t) => {
    const h = await start(t, { spend: [[2], [5, "dev"], [11, "personal"]] });
    const dev = await h.load("jig-bedrock-dev");
    const top = await h.load("jig-bedrock");
    h.ctx.model = dev;
    await h.command("status");
    const devBlock = block(h, "Bedrock · dev ·");
    assert.match(devBlock, /^Bedrock · dev · /, JSON.stringify(h.notices));
    assert.match(devBlock, /Spend: .* \$7\.00 of \$100/, devBlock);
    assert.match(devBlock, /Selected model: claude-haiku-5-5/, devBlock);
    await h.command("set regions us-west-2");
    const devSet = block(h, "Bedrock settings");
    assert.match(devSet, /^Bedrock settings · dev\b/, devSet);
    assert.match(devSet, /saved to preset dev/, devSet);
    let saved = savedSettings(h);
    assert.deepEqual(saved.presets.dev.regions, ["us-west-2"]);
    assert.deepEqual(saved.regions, [REGION]);

    h.ctx.model = top;
    await h.command("status");
    const topBlock = block(h, "Bedrock ·");
    assert.doesNotMatch(topBlock, /^Bedrock · dev ·/, topBlock);
    assert.match(topBlock, /Spend: .* \$2\.00 of \$100/, topBlock);
    assert.match(topBlock, /Selected model: claude-sonnet-5-5/, topBlock);
    await h.command("set regions eu-west-1");
    const topSet = block(h, "Bedrock settings");
    assert.doesNotMatch(topSet, /^Bedrock settings · dev ·/, topSet);
    assert.match(topSet, /saved to bedrock.json/, topSet);
    saved = savedSettings(h);
    assert.deepEqual(saved.regions, ["eu-west-1"]);
    assert.deepEqual(saved.presets.dev.regions, ["us-west-2"]);

    // With no model chosen, Pi's saved default names the preset.
    writeFileSync(
        join(h.agent, "settings.json"),
        JSON.stringify({ defaultProvider: "jig-bedrock-dev", defaultModel: "claude-haiku-5-5" }),
    );
    h.ctx.model = undefined;
    await h.command("status");
    const savedBlock = block(h, "Bedrock ·");
    assert.match(savedBlock, /^Bedrock · dev · /, savedBlock);
    assert.match(savedBlock, /Spend: .* \$7\.00 of \$100/, savedBlock);
});

test("the budget notice names the preset of the model in use", async (t) => {
    const h = await start(t, { spend: [[2], [90, "dev"]] });
    const dev = await h.load("jig-bedrock-dev");
    const top = await h.load("jig-bedrock");
    h.ctx.model = dev;
    await h.fire("model_select", { source: "set", model: dev });
    assert.equal(h.notices.length, 1, JSON.stringify(h.notices));
    assert.match(
        h.notices[0] ?? "",
        /^dev: Bedrock spend is at 92% of the \$100 monthly budget \(\$92\)/,
        h.notices[0],
    );
    h.ctx.model = top;
    await h.fire("model_select", { source: "set", model: top });
    assert.equal(h.notices.length, 1, "the top level is only $2 into its budget");
});

test("session_start starts the footer of the model in use", async (t) => {
    const h = await start(t, { spend: [[2], [5, "dev"]] });
    const dev = await h.load("jig-bedrock-dev");
    h.ctx.model = dev;
    await h.fire("session_start", { reason: "startup" });
    await h.until(() => h.statuses.some((status) => status?.startsWith("dev · ")));
    assert.ok(
        h.statuses.some((status) => status === `dev · ${month().split(" ")[0]} $7.00 / $100`),
        JSON.stringify(h.statuses),
    );
});
