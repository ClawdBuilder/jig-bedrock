// The real provider and /bedrock commands, with a fake catalog that follows the active profile.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { catalogFileFor } from "../src/cache-root.ts";
import { loadConfig } from "../src/config.ts";
import { createBedrockProvider } from "../src/provider.ts";

const region = "us-east-1";
const account = "123456789012";
const arn = (id: string) => `arn:aws:bedrock:${region}:${account}:inference-profile/${id}`;
const profile = (id: string) => ({
    arn: arn(`global.anthropic.${id}`),
    profile_name: `Global ${id}`,
    foundation_model_id: id,
    region,
    kind: "system",
});
const catalog = (...ids: string[]) => ({
    schema: 1 as const,
    mode: "system" as const,
    aws_profile: "work",
    account_id: account,
    regions: [region],
    fetched_at: Math.floor(Date.now() / 1000),
    profiles: ids.map(profile),
});
function setup(t: test.TestContext, shared?: string) {
    const dir = shared ?? mkdtempSync(join(tmpdir(), "bedrock-presets-provider-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "bedrock.json");
    writeFileSync(
        file,
        JSON.stringify({
            presets: {
                work: { profile: "work" },
                personal: { profile: "personal" },
            },
            preset: "work",
            ssoLoginCommand: ["echo", "SIGN-IN-WOULD-START", "{profile}"],
        }),
    );
    let calls = 0;
    const h = {
        hooks: new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>(),
        commands: new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>(),
        notices: [] as string[],
        providers: [] as Array<{ getModels?: () => Array<{ id: string }> }>,
    };
    const pi = {
        on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
            h.hooks.set(name, [...(h.hooks.get(name) ?? []), fn]);
        },
        registerProvider(provider: { getModels?: () => Array<{ id: string }> }) {
            h.providers.push(provider);
        },
        registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            h.commands.set(name, options);
        },
        events: { emit() {} },
        setModel: () => true,
    };
    const ctx = {
        mode: "rpc",
        hasUI: true,
        model: undefined,
        sessionManager: { getBranch: () => [], getSessionId: () => "test" },
        modelRegistry: { find: () => undefined },
        ui: {
            notify: (text: string) => h.notices.push(text),
            setStatus: () => {},
        },
    };
    return { dir, file, h, pi, ctx, calls: () => calls, bump: () => calls++ };
}
async function start(t: test.TestContext, options: { env?: NodeJS.ProcessEnv; ids?: string[]; fresh?: boolean } = {}) {
    const s = setup(t);
    const raw = JSON.parse(readFileSync(s.file, "utf8")) as Record<string, unknown>;
    const resolved = loadConfig({
        raw,
        env: options.env ?? { HOME: s.dir, PI_CODING_AGENT_DIR: s.dir },
        agentDir: s.dir,
    });
    assert.ok(resolved.config);
    let current = catalog("anthropic.claude-haiku-5-5");
    const source = {
        load: () => current,
        refresh: async () => {
            if (options.fresh) return "ok" as const;
            s.bump();
            current = catalog("anthropic.claude-sonnet-5-5");
            return "ok" as const;
        },
        failure: () => undefined,
    };
    const provider = await createBedrockProvider({
        env: { HOME: s.dir, PI_CODING_AGENT_DIR: s.dir, ...options.env },
        config: resolved.config,
        catalog: source,
        listProfiles: async () => ["work", "personal"],
        backgroundRefresh: false,
    })(s.pi as never);
    assert.ok(provider);
    return { ...s, provider, source, commands: s.h.commands, notices: s.h.notices };
}
const models = (h: { providers: Array<{ getModels?: () => Array<{ id: string }> }> }) =>
    h.providers
        .at(-1)
        ?.getModels?.()
        .map((model) => model.id) ?? [];

test("/bedrock use changes the registered model list with no reload", async (t) => {
    const s = await start(t);
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    assert.ok(models(s.h).includes("claude-sonnet-5-5"), JSON.stringify(models(s.h)));
    const workFile = catalogFileFor({ profile: "work", mode: "system", regions: [region] }, { HOME: s.dir }, true);
    const personalFile = catalogFileFor(
        { profile: "personal", mode: "system", regions: [region] },
        { HOME: s.dir },
        true,
    );
    assert.notEqual(workFile, personalFile);
    assert.match(s.notices.join("\n"), /preset personal is active/);
});

test("a fresh switch makes no discovery, a missing list makes one", async (t) => {
    const fresh = await start(t, { fresh: true });
    await fresh.commands.get("bedrock")?.handler("use personal", fresh.ctx);
    assert.equal(fresh.calls(), 0);
    const empty = await start(t);
    empty.source.load = () => undefined;
    await empty.commands.get("bedrock")?.handler("use personal", empty.ctx);
    assert.equal(empty.calls(), 1);
});

test("the selected model stays when its id exists, and one notice when it does not", async (t) => {
    const s = await start(t);
    const before = s.provider.models.find((model) => model.id === "claude-haiku-5-5");
    assert.ok(before);
    s.ctx.model = { ...before, provider: "jig-bedrock" } as never;
    s.source.refresh = async () => {
        s.bump();
        return "ok";
    };
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    const after = s.provider.models.find((model) => model.id === "claude-haiku-5-5");
    assert.ok(after, "the id is still in the list");

    const missing = await start(t);
    const old = missing.provider.models.find((model) => model.id === "claude-haiku-5-5");
    assert.ok(old);
    missing.ctx.model = { ...old, provider: "jig-bedrock" } as never;
    missing.source.load = () => catalog("anthropic.claude-sonnet-5-5");
    await missing.commands.get("bedrock")?.handler("use personal", missing.ctx);
    assert.match(missing.notices.join("\n"), /claude-haiku-5-5 is not in preset personal/);
});

test("JIG_BEDROCK_PRESET switches only this process and leaves the file alone", async (t) => {
    const s = await start(t, { env: { JIG_BEDROCK_PRESET: "work" } });
    const before = readFileSync(s.file, "utf8");
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    assert.equal(readFileSync(s.file, "utf8"), before);
    assert.match(s.notices.join("\n"), /for this Pi only/);
});

test("/bedrock use lists every preset and marks the active one", async (t) => {
    const s = await start(t);
    await s.commands.get("bedrock")?.handler("use", s.ctx);
    const text = s.notices.join("\n");
    assert.match(text, /personal/);
    assert.match(text, /work/);
    assert.match(text, /active \(file\)/);
});

test("preset add snapshots the effective profile and refuses an existing name", async (t) => {
    const s = await start(t);
    await s.commands.get("bedrock")?.handler("preset add extra", s.ctx);
    const parsed = JSON.parse(readFileSync(s.file, "utf8")) as {
        presets: Record<string, { profile?: string }>;
        preset?: string;
    };
    assert.equal(parsed.presets.extra?.profile, "work");
    assert.equal(parsed.preset, "extra");
    const before = readFileSync(s.file, "utf8");
    await s.commands.get("bedrock")?.handler("preset add extra", s.ctx);
    assert.equal(readFileSync(s.file, "utf8"), before);
    await s.commands.get("bedrock")?.handler("preset remove extra", s.ctx);
    const after = JSON.parse(readFileSync(s.file, "utf8")) as { preset?: string };
    assert.equal(after.preset, undefined);
});

test("no presets keeps the 0.3.3 footer and catalog path", async (t) => {
    const s = setup(t);
    writeFileSync(s.file, JSON.stringify({ profile: "work" }));
    const resolved = loadConfig({
        raw: JSON.parse(readFileSync(s.file, "utf8")),
        env: { HOME: s.dir, PI_CODING_AGENT_DIR: s.dir },
        agentDir: s.dir,
    });
    assert.ok(resolved.config);
    assert.equal(resolved.config.preset, undefined);
    const tracker = new (await import("../src/spend.ts")).SpendTracker(resolved.config, {
        HOME: s.dir,
        PI_CODING_AGENT_DIR: s.dir,
    });
    assert.doesNotMatch(tracker.footerText(), / · /);
});

test("two providers with two JIG_BEDROCK_PRESET values use two catalog files and make no AWS call", async (t) => {
    const shared = mkdtempSync(join(tmpdir(), "bedrock-presets-shared-"));
    t.after(() => rmSync(shared, { recursive: true, force: true }));
    const a = await start(t, { env: { JIG_BEDROCK_PRESET: "work" }, dir: shared });
    const b = await start(t, { env: { JIG_BEDROCK_PRESET: "personal" }, dir: shared });
    const files = new Set([
        catalogFileFor({ profile: "work", mode: "system", regions: [region] }, { HOME: shared }, true),
        catalogFileFor({ profile: "personal", mode: "system", regions: [region] }, { HOME: shared }, true),
    ]);
    assert.equal(files.size, 2);
    assert.equal(a.calls() + b.calls(), 0, "both providers used their cached list");
});

test("preset remove of the active preset unsets it, and the next list has no active mark", async (t) => {
    const s = await start(t);
    await s.commands.get("bedrock")?.handler("preset add extra", s.ctx);
    await s.commands.get("bedrock")?.handler("preset remove extra", s.ctx);
    const parsed = JSON.parse(readFileSync(s.file, "utf8")) as { preset?: string; presets: Record<string, unknown> };
    assert.equal(parsed.preset, undefined);
    assert.equal(parsed.presets.extra, undefined);
    await s.commands.get("bedrock")?.handler("use", s.ctx);
    assert.doesNotMatch(s.notices.at(-1) ?? "", /active/);
});

test("a switch with no saved list waits for discovery before judging the selected id", async (t) => {
    const s = await start(t);
    const selected = s.provider.models.find((model) => model.id === "claude-haiku-5-5");
    assert.ok(selected);
    s.ctx.model = { ...selected, provider: "jig-bedrock" } as never;
    s.source.load = () => undefined;
    s.source.refresh = async () => {
        s.bump();
        s.source.load = () => catalog("anthropic.claude-haiku-5-5");
        return "ok";
    };
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotMatch(s.notices.join("\n"), /is not in preset/);
});

test("a fresh saved list without the selected id warns once, after it is registered", async (t) => {
    const s = await start(t);
    const selected = s.provider.models.find((model) => model.id === "claude-haiku-5-5");
    assert.ok(selected);
    s.ctx.model = { ...selected, provider: "jig-bedrock" } as never;
    s.source.load = () => catalog("anthropic.claude-sonnet-5-5");
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    assert.equal(s.notices.filter((text) => text.includes("is not in preset personal")).length, 1);
});

test("a list that loses the selected id after background discovery warns once, after it finishes", async (t) => {
    const s = await start(t);
    const selected = s.provider.models.find((model) => model.id === "claude-haiku-5-5");
    assert.ok(selected);
    s.ctx.model = { ...selected, provider: "jig-bedrock" } as never;
    s.source.refresh = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        s.source.load = () => catalog("anthropic.claude-sonnet-5-5");
        return "ok";
    };
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    assert.doesNotMatch(s.notices.join("\n"), /is not in preset/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(s.notices.filter((text) => text.includes("is not in preset personal")).length, 1);
});
