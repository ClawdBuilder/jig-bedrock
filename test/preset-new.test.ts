/* biome-ignore-all lint/suspicious/noExplicitAny: provider and Pi doubles */
/* biome-ignore-all lint/style/noNonNullAssertion: test assertions */
// `New preset…` and `/bedrock preset new` guide a short setup that reuses /login's own prompts: name, AWS profile,
// discovery, tag pair and second tag, regions. A cancelled setup writes nothing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const system = (foundation: string): FakeAwsProfile => ({
    arn: `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.${foundation}`,
    name: `System ${foundation}`,
    region: REGION,
    foundation,
    tags: {},
    kind: "system",
});
const application = (name: string, active: string, foundation: string): FakeAwsProfile => ({
    arn: `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/${name}`,
    name,
    region: REGION,
    foundation,
    tags: { Team: "fixture-team", Active: active },
    kind: "application",
});

/** A fake aws on PATH that records any start; the tag lookup must never start one. */
function trapAws(dir: string): { bin: string; marker: string } {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const marker = join(dir, "aws-ran");
    writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "$*" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
    return { bin, marker };
}

async function start(t: test.TestContext, raw: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-preset-new-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const file = join(agent, "bedrock.json");
    writeFileSync(file, JSON.stringify(raw));
    const aws = trapAws(dir);
    const env: NodeJS.ProcessEnv = {
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        XDG_CACHE_HOME: join(dir, "cache"),
        PATH: `${aws.bin}:${process.env.PATH ?? ""}`,
    };
    const fake = fakeAwsHttp({
        profiles: [
            application("team-app", "true", "anthropic.claude-sonnet-5-5"),
            application("team-old", "false", "anthropic.claude-haiku-5-5"),
            system("anthropic.claude-haiku-5-5"),
        ],
    });
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const commands = new Map<string, any>();
    const notices: string[] = [];
    const selections: any[] = [];
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
            selections.push(model);
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
    return { dir, agent, file, env, fake, aws, providers, commands, notices, selections, ctx, handle };
}

function scriptUi(ctx: any, selects: Array<string | undefined>, inputs: Array<string | undefined>) {
    const calls: Array<{ title: string; options?: string[] }> = [];
    ctx.ui.select = async (title: string, options: string[] = []) => {
        calls.push({ title, options: [...options] });
        const wanted = selects.shift();
        if (wanted === undefined) return undefined;
        return options.find((option) => option === wanted || option.startsWith(wanted)) ?? wanted;
    };
    ctx.ui.input = async (title: string) => {
        calls.push({ title });
        return inputs.shift();
    };
    return calls;
}

async function presetNew(
    h: Awaited<ReturnType<typeof start>>,
    selects: Array<string | undefined>,
    inputs: Array<string | undefined>,
) {
    const calls = scriptUi(h.ctx, selects, inputs);
    await h.commands.get("bedrock")?.handler("preset new", h.ctx);
    return calls;
}

const modelsOf = (h: Awaited<ReturnType<typeof start>>): string[] =>
    h.providers
        .at(-1)
        ?.getModels?.()
        .map((model: { id: string }) => model.id) ?? [];

async function waitForModels(h: Awaited<ReturnType<typeof start>>): Promise<string[]> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const ids = modelsOf(h);
        if (ids.length > 0) return ids;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return modelsOf(h);
}

test("a guided AWS-defined preset is saved with discovery and switched to", async (t) => {
    const h = await start(t, { profile: "fixture", regions: [REGION] });
    const calls = await presetNew(h, ["fixture", "All AWS-defined Claude inference profiles"], ["work", ""]);
    assert.ok(
        calls.some((call) => call.title === "Which AWS profile should Bedrock use?"),
        JSON.stringify(calls),
    );
    assert.ok(
        calls.some((call) => call.title === "Which inference profiles should Bedrock list?"),
        JSON.stringify(calls),
    );
    const namePrompt = calls.find((call) => call.title.startsWith("New preset name"));
    assert.match(namePrompt?.title ?? "", /letters, digits, \. _ - · up to 40/, JSON.stringify(calls));
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as {
        preset?: string;
        presets: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(saved.presets.work, {
        profile: "fixture",
        discovery: "aws-defined",
        regions: [REGION],
    });
    assert.equal(saved.preset, "work");
    assert.match(h.notices.join("\n"), /Preset work is active: fixture · AWS-defined/);
    const ids = await waitForModels(h);
    assert.ok(ids.includes("claude-haiku-5-5"), JSON.stringify(ids));
});

test("a guided tag preset offers the second tag and saves it", async (t) => {
    const h = await start(t, { profile: "fixture", regions: [REGION] });
    const calls = await presetNew(
        h,
        ["fixture", "Inference profiles with a tag I name", "Only the 1 with Active=true"],
        ["team", "Team", "fixture-team", ""],
    );
    const offer = calls.find((call) => call.title.includes("also splits by"));
    assert.ok(offer, JSON.stringify(calls));
    assert.ok(offer?.options?.includes("Only the 1 with Active=true"), JSON.stringify(offer));
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as {
        preset?: string;
        presets: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(saved.presets.team, {
        profile: "fixture",
        discovery: "tag",
        regions: [REGION],
        tagKey: "Team",
        tagValue: "fixture-team",
        activeTagKey: "Active",
        activeTagValue: "true",
    });
    assert.equal(saved.preset, "team");
    assert.match(h.notices.join("\n"), /Preset team is active: fixture · by tag/);
    const ids = await waitForModels(h);
    assert.ok(ids.includes("claude-sonnet-5-5"), JSON.stringify(ids));
    assert.equal(ids.includes("claude-haiku-5-5"), false, JSON.stringify(ids));
    assert.equal(existsSync(h.aws.marker), false, "the second-tag lookup starts no aws program");
});

test("Escape half-way writes nothing", async (t) => {
    const h = await start(t, { profile: "fixture", regions: [REGION] });
    const before = readFileSync(h.file, "utf8");
    const calls = await presetNew(h, ["fixture", "Inference profiles with a tag I name"], ["half", "Team", undefined]);
    assert.ok(
        calls.some((call) => call.title === "Which inference profiles should Bedrock list?"),
        JSON.stringify(calls),
    );
    assert.equal(readFileSync(h.file, "utf8"), before, "a cancelled setup writes nothing");
    assert.doesNotMatch(h.notices.join("\n"), /is active/, h.notices.join("\n"));
});

test("an existing preset name is refused and nothing is overwritten", async (t) => {
    const raw = {
        profile: "fixture",
        regions: [REGION],
        presets: { work: { profile: "fixture", discovery: "aws-defined", regions: [REGION] } },
    };
    const h = await start(t, raw);
    const before = readFileSync(h.file, "utf8");
    await presetNew(h, [], ["work", undefined]);
    assert.match(h.notices.join("\n"), /Preset work already exists/);
    assert.equal(readFileSync(h.file, "utf8"), before);
});
