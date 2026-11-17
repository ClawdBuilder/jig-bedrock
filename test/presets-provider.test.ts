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
function setup(t: test.TestContext, shared?: string, settings?: Record<string, unknown>) {
    const dir = shared ?? mkdtempSync(join(tmpdir(), "bedrock-presets-provider-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "bedrock.json");
    writeFileSync(
        file,
        JSON.stringify(
            settings ?? {
                presets: {
                    work: { profile: "work" },
                    personal: { profile: "personal" },
                },
                preset: "work",
                ssoLoginCommand: ["echo", "SIGN-IN-WOULD-START", "{profile}"],
            },
        ),
    );
    let calls = 0;
    const h = {
        hooks: new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>(),
        commands: new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>(),
        notices: [] as string[],
        providers: [] as Array<{ id?: string; getModels?: () => Array<{ id: string }> }>,
        selected: [] as Array<{ provider: string; id: string }>,
        unregistered: [] as string[],
        branch: [] as Array<Record<string, unknown>>,
    };
    const pi = {
        on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
            h.hooks.set(name, [...(h.hooks.get(name) ?? []), fn]);
        },
        registerProvider(provider: { id?: string; getModels?: () => Array<{ id: string }> }) {
            h.providers.push(provider);
        },
        unregisterProvider(id: string) {
            h.unregistered.push(id);
            const at = h.providers.findIndex((entry) => entry.id === id);
            if (at >= 0) h.providers.splice(at, 1);
        },
        registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            h.commands.set(name, options);
        },
        events: { emit() {} },
        setModel: async (model: { provider: string; id: string }) => {
            h.selected.push({ provider: model.provider, id: model.id });
            ctx.model = model as never;
            return true;
        },
    };
    const ctx = {
        mode: "rpc",
        hasUI: true,
        model: undefined,
        sessionManager: { getBranch: () => h.branch, getSessionId: () => "test" },
        modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
        ui: {
            notify: (text: string) => h.notices.push(text),
            setStatus: () => {},
        },
    };
    return { dir, file, h, pi, ctx, calls: () => calls, bump: () => calls++ };
}
async function start(
    t: test.TestContext,
    options: {
        env?: NodeJS.ProcessEnv;
        ids?: string[];
        fresh?: boolean;
        byProfile?: boolean;
        settings?: Record<string, unknown>;
        catalogIds?: string[];
    } = {},
) {
    const s = setup(t, undefined, options.settings);
    const raw = JSON.parse(readFileSync(s.file, "utf8")) as Record<string, unknown>;
    const resolved = loadConfig({
        raw,
        env: options.env ?? { HOME: s.dir, PI_CODING_AGENT_DIR: s.dir },
        agentDir: s.dir,
    });
    assert.ok(resolved.config);
    let current = catalog(...(options.catalogIds ?? ["anthropic.claude-haiku-5-5"]));
    const source = {
        load: () =>
            options.byProfile
                ? catalog(
                      resolved.config.profile === "personal"
                          ? "anthropic.claude-sonnet-5-5"
                          : "anthropic.claude-haiku-5-5",
                  )
                : current,
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

const providerOf = (h: { providers: Array<{ id?: string; getModels?: () => Array<{ id: string }> }> }, id: string) =>
    [...h.providers].reverse().find((entry) => entry.id === id);
const fireHooks = async (
    h: { hooks: Map<string, Array<(event: any, ctx: any) => unknown>> },
    name: string,
    event: unknown,
    ctx: unknown,
): Promise<void> => {
    for (const hook of h.hooks.get(name) ?? []) await hook(event, ctx);
};

test("/bedrock use selects a model of that preset and writes `preset`", async (t) => {
    const s = await start(t);
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    assert.deepEqual(s.h.selected.at(-1), { provider: "jig-bedrock-personal", id: "claude-haiku-5-5" });
    assert.equal((JSON.parse(readFileSync(s.file, "utf8")) as { preset?: string }).preset, "personal");
    assert.match(s.notices.join("\n"), /Preset personal is active: personal · AWS-defined/);
});

test("use picks this session's last model, then the saved default, then the first", async (t) => {
    const catalogIds = ["anthropic.claude-haiku-5-5", "anthropic.claude-sonnet-5-5"];
    const remembered = await start(t, { catalogIds });
    remembered.h.branch.push({
        type: "model_change",
        provider: "jig-bedrock-personal",
        modelId: "claude-haiku-5-5",
    });
    await remembered.commands.get("bedrock")?.handler("use personal", remembered.ctx);
    assert.equal(remembered.h.selected.at(-1)?.id, "claude-haiku-5-5", "the session's last model wins");

    const saved = await start(t, { catalogIds });
    writeFileSync(
        join(saved.dir, "settings.json"),
        JSON.stringify({ defaultProvider: "jig-bedrock-personal", defaultModel: "claude-haiku-5-5" }),
    );
    await saved.commands.get("bedrock")?.handler("use personal", saved.ctx);
    assert.equal(saved.h.selected.at(-1)?.id, "claude-haiku-5-5", "Pi's saved default comes second");

    const first = await start(t, { catalogIds });
    await first.commands.get("bedrock")?.handler("use personal", first.ctx);
    assert.equal(first.h.selected.at(-1)?.id, "claude-sonnet-5-5", "otherwise its first model");
});

test("use keeps the provider list and starts no discovery", async (t) => {
    const s = await start(t);
    const providers = s.h.providers.length;
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    assert.equal(s.h.providers.length, providers, "selecting a model re-registers nothing");
    assert.equal(s.calls(), 0, "the cached catalog was enough");
});

test("JIG_BEDROCK_PRESET shows its provider only, switches in this process, and leaves the file alone", async (t) => {
    const s = await start(t, { env: { JIG_BEDROCK_PRESET: "work" } });
    assert.deepEqual(
        s.h.providers.map((entry) => entry.id).sort(),
        ["jig-bedrock", "jig-bedrock-work"],
        "plain plus the named preset only",
    );
    const before = readFileSync(s.file, "utf8");
    await s.commands.get("bedrock")?.handler("use work", s.ctx);
    assert.deepEqual(s.h.selected.at(-1), { provider: "jig-bedrock-work", id: "claude-haiku-5-5" });
    assert.equal(readFileSync(s.file, "utf8"), before, "the file is not rewritten");
    assert.match(s.notices.join("\n"), /for this Pi only/);
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    assert.match(s.notices.at(-1) ?? "", /Unknown preset personal/);
});

test("/bedrock use marks the model's preset active", async (t) => {
    const s = await start(t);
    await s.commands.get("bedrock")?.handler("use personal", s.ctx);
    await s.commands.get("bedrock")?.handler("use", s.ctx);
    const listing = s.notices.at(-1) ?? "";
    assert.match(listing, /ok personal .* · active \(model in use\)/, listing);
    assert.doesNotMatch(listing, /ok Top-level settings/, listing);
});

test("preset add copies the current runtime's config, registers at once and selects its model", async (t) => {
    const s = await start(t);
    const work = providerOf(s.h, "jig-bedrock-work");
    assert.ok(work);
    s.ctx.model = { ...(work.getModels?.()[0] as never), provider: "jig-bedrock-work" } as never;
    const callsBefore = s.calls();
    const providersBefore = s.h.providers.length;
    await s.commands.get("bedrock")?.handler("preset add extra", s.ctx);
    const parsed = JSON.parse(readFileSync(s.file, "utf8")) as {
        presets: Record<string, { profile?: string }>;
        preset?: string;
    };
    assert.equal(parsed.presets.extra?.profile, "work");
    assert.equal(parsed.preset, "extra");
    assert.equal(s.calls(), callsBefore, "the cached catalog was enough: no discovery");
    assert.equal(s.h.providers.length, providersBefore + 1);
    assert.deepEqual(
        providerOf(s.h, "jig-bedrock-extra")
            ?.getModels?.()
            .map((model) => model.id),
        ["claude-haiku-5-5"],
    );
    assert.deepEqual(s.h.selected.at(-1), { provider: "jig-bedrock-extra", id: "claude-haiku-5-5" });
    assert.match(s.notices.join("\n"), /Preset extra saved and active/);
    const before = readFileSync(s.file, "utf8");
    await s.commands.get("bedrock")?.handler("preset add extra", s.ctx);
    assert.equal(readFileSync(s.file, "utf8"), before, "an existing name is refused unchanged");
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

test("preset remove unregisters at once, and on the next model change when its model is in use", async (t) => {
    const s = await start(t);
    await s.commands.get("bedrock")?.handler("preset remove personal", s.ctx);
    assert.deepEqual(s.h.unregistered, ["jig-bedrock-personal"]);
    assert.equal(providerOf(s.h, "jig-bedrock-personal"), undefined);

    const inUse = await start(t);
    const work = providerOf(inUse.h, "jig-bedrock-work");
    assert.ok(work);
    inUse.ctx.model = { ...(work.getModels?.()[0] as never), provider: "jig-bedrock-work" } as never;
    await inUse.commands.get("bedrock")?.handler("preset remove work", inUse.ctx);
    assert.deepEqual(inUse.h.unregistered, [], "the provider stays while its model is in use");
    assert.match(inUse.notices.join("\n"), /removed while its model is in use/);
    const inputHook = inUse.h.hooks.get("input")?.[0];
    assert.ok(inputHook, "the selection guard registers an input hook");
    const input = (await inputHook({ text: "hi", source: "interactive" }, inUse.ctx)) as { action?: string };
    assert.equal(input?.action, "handled", "input is blocked until a choice is made");
    const top = providerOf(inUse.h, "jig-bedrock");
    assert.ok(top);
    inUse.ctx.model = { ...(top.getModels?.()[0] as never), provider: "jig-bedrock" } as never;
    await fireHooks(inUse.h, "model_select", { source: "set", model: inUse.ctx.model }, inUse.ctx);
    assert.deepEqual(inUse.h.unregistered, ["jig-bedrock-work"]);
    assert.equal(providerOf(inUse.h, "jig-bedrock-work"), undefined);
    assert.equal(
        (JSON.parse(readFileSync(inUse.file, "utf8")) as { preset?: string; presets: Record<string, unknown> }).preset,
        undefined,
    );
});

test("the presets menu labels a preset with the mode it really runs", async (t) => {
    const s = await start(t, {
        settings: {
            profile: "work",
            tagKey: "Team",
            tagValue: "fixture",
            regions: [region],
            presets: { personal: { profile: "personal", regions: [region] } },
            preset: "work",
        },
    });
    const calls: Array<{ title: string; options: string[] }> = [];
    const script: Array<string | undefined> = ["Presets", undefined];
    s.ctx.mode = "tui";
    (s.ctx.ui as unknown as Record<string, unknown>).select = async (title: string, options: string[] = []) => {
        calls.push({ title, options });
        const next = script.shift();
        return next === undefined
            ? undefined
            : (options.find((option) => option === next || option.startsWith(next)) ?? next);
    };
    await s.commands.get("bedrock")?.handler("", s.ctx);
    const presets = calls.find((call) => call.title.startsWith("Bedrock presets"));
    assert.ok(presets, JSON.stringify(calls));
    const row = presets.options.find((option) => option.includes("personal"));
    assert.match(row ?? "", /personal — personal · by tag/, JSON.stringify(presets.options));
    assert.doesNotMatch(row ?? "", /AWS-defined/, JSON.stringify(presets.options));
});

test("the presets menu shows the profile a preset would really use", async (t) => {
    const s = await start(t, {
        settings: {
            profile: "work",
            tagKey: "Team",
            tagValue: "fixture",
            regions: [region],
            presets: { inherited: { regions: [region] }, personal: { profile: "personal" } },
            preset: "work",
        },
    });
    const calls: Array<{ title: string; options: string[] }> = [];
    const script: Array<string | undefined> = ["Presets", undefined];
    s.ctx.mode = "tui";
    (s.ctx.ui as unknown as Record<string, unknown>).select = async (title: string, options: string[] = []) => {
        calls.push({ title, options });
        const next = script.shift();
        return next === undefined
            ? undefined
            : (options.find((option) => option === next || option.startsWith(next)) ?? next);
    };
    await s.commands.get("bedrock")?.handler("", s.ctx);
    const presets = calls.find((call) => call.title.startsWith("Bedrock presets"));
    assert.ok(presets, JSON.stringify(calls));
    const inherited = presets.options.find((option) => option.startsWith("inherited"));
    assert.match(inherited ?? "", /^inherited — work · by tag/, JSON.stringify(presets.options));
    const personal = presets.options.find((option) => option.startsWith("personal"));
    assert.match(personal ?? "", /^personal — personal · by tag/, JSON.stringify(presets.options));
});
