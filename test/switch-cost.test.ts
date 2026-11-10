import assert from "node:assert/strict";
import test from "node:test";
import { registerStatisticsCommands } from "../src/commands.ts";
import { cacheWriteRate, promptCacheFor, retentionOf } from "../src/prompt-cache.ts";
import { registerSwitchNotice, switchNotice, tokensLabel } from "../src/switch-cost.ts";

type Hook = (...args: any[]) => any;

const opus = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 5 };
test("retention follows PI_CACHE_RETENTION exactly as Pi's Bedrock stream reads it", () => {
    assert.equal(retentionOf({}), "short");
    assert.equal(retentionOf({ PI_CACHE_RETENTION: "long" }), "long");
    assert.equal(retentionOf({ PI_CACHE_RETENTION: "short" }), "short");
    assert.equal(retentionOf({ PI_CACHE_RETENTION: "LONG" }), "short");
});
test("cache write rate is the model's 5-minute rate or twice the input rate for one hour, in the tier the request falls into", () => {
    const flat = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    assert.equal(cacheWriteRate(flat, 190_000, "short"), 6.25);
    assert.equal(cacheWriteRate(flat, 190_000, "long"), 10);
    const tiered = {
        ...flat,
        tiers: [{ input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5, inputTokensAbove: 200_000 }],
    };
    assert.equal(cacheWriteRate(tiered, 190_000, "short"), 6.25);
    assert.equal(cacheWriteRate(tiered, 250_000, "short"), 12.5);
    assert.equal(cacheWriteRate(tiered, 250_000, "long"), 20);
});
test("the notice prices the current context at the target's cache-write rate", () => {
    assert.equal(
        switchNotice(190_000, opus, "short")?.text,
        "Switching model rewrites ~190k tokens of cache: about $0.95 (once). For one hard question, switch for that request only and switch back.",
    );
    assert.equal(
        switchNotice(190_000, opus, "long")?.text,
        "Switching model rewrites ~190k tokens of cache: about $1.90 (once). For one hard question, switch for that request only and switch back.",
    );
    assert.match(switchNotice(1_250_000, opus, "short")!.text, /~1\.3M tokens/);
    assert.equal(switchNotice(5_000, opus, "short"), undefined, "a few cents is not worth a notice");
    assert.equal(switchNotice(0, opus, "short"), undefined);
    assert.equal(switchNotice(Number.NaN, opus, "short"), undefined);
    assert.equal(tokensLabel(999), "1k");
    assert.equal(tokensLabel(182_400), "182k");
});

function harness(env: NodeJS.ProcessEnv = {}) {
    const hooks = new Map<string, Hook[]>(),
        notices: string[] = [];
    registerSwitchNotice({ on: (name: string, fn: Hook) => hooks.set(name, [...(hooks.get(name) || []), fn]) } as any, {
        env,
    });
    const model = (id: string, extra: object = {}) => ({
        provider: "jig-bedrock",
        id,
        cost: opus,
        promptCache: promptCacheFor("anthropic.claude-opus-5-5"),
        ...extra,
    });
    const ctx = (tokens: number | null | undefined, branch: any[] = [], mode = "tui") => ({
        mode,
        getContextUsage: () => (tokens === undefined ? undefined : { tokens }),
        sessionManager: { getBranch: () => branch },
        ui: { notify: (text: string) => notices.push(text) },
    });
    const select = (event: object, c: any) => {
        for (const fn of hooks.get("model_select") || []) fn({ type: "model_select", ...event }, c);
    };
    return { hooks, notices, model, ctx, select };
}
const response = (ageMs: number, extra: object = {}) => ({
    type: "message",
    message: { role: "assistant", stopReason: "stop", timestamp: Date.now() - ageMs, ...extra },
});

test("a switch with context notifies once, for the target model, with its own rate", () => {
    const h = harness();
    h.select(
        {
            model: h.model("opus", { cost: { ...opus, cacheWrite: 6.25 } }),
            previousModel: h.model("sonnet"),
            source: "set",
        },
        h.ctx(190_000, [response(60_000)]),
    );
    assert.deepEqual(h.notices, [
        "Switching model rewrites ~190k tokens of cache: about $1.19 (once). For one hard question, switch for that request only and switch back.",
    ]);
    h.select(
        { model: h.model("sonnet"), previousModel: h.model("opus"), source: "cycle" },
        h.ctx(190_000, [response(60_000)]),
    );
    assert.equal(h.notices.length, 2);
});
test("the 1-hour rate applies when Pi writes 1-hour cache points", () => {
    const h = harness({ PI_CACHE_RETENTION: "long" });
    h.select(
        { model: h.model("opus"), previousModel: h.model("sonnet"), source: "set" },
        h.ctx(190_000, [response(30 * 60_000)]),
    );
    assert.match(h.notices[0]!, /about \$1\.90/);
});
test("no notice for a restore, the first selection, the same model, a model outside the team catalog, or print mode", () => {
    const h = harness(),
        c = h.ctx(190_000, [response(1000)]);
    h.select({ model: h.model("opus"), previousModel: h.model("sonnet"), source: "restore" }, c);
    h.select({ model: h.model("opus"), previousModel: undefined, source: "set" }, c);
    h.select({ model: h.model("opus"), previousModel: h.model("opus"), source: "set" }, c);
    h.select(
        { model: { provider: "openai-codex", id: "gpt", cost: opus }, previousModel: h.model("opus"), source: "set" },
        c,
    );
    h.select(
        { model: h.model("opus"), previousModel: h.model("sonnet"), source: "set" },
        h.ctx(190_000, [response(1000)], "print"),
    );
    assert.deepEqual(h.notices, []);
});
test("no notice without context: an empty session, unknown size right after a compaction, or pocket change", () => {
    const h = harness(),
        event = { model: h.model("opus"), previousModel: h.model("sonnet"), source: "set" };
    h.select(event, h.ctx(0));
    h.select(event, h.ctx(null));
    h.select(event, h.ctx(undefined));
    h.select(event, h.ctx(4_000, [response(1000)]));
    assert.deepEqual(h.notices, []);
});
test("an expired cache is rewritten whichever model answers, so there is nothing to warn about; a cache-warming refresh keeps it alive", () => {
    const h = harness(),
        event = {
            model: h.model("opus"),
            previousModel: h.model("sonnet", { promptCache: { short: 300, long: 3600 } }),
            source: "set",
        };
    h.select(event, h.ctx(190_000, [response(6 * 60_000)]));
    assert.deepEqual(h.notices, []);
    h.select(
        event,
        h.ctx(190_000, [
            response(6 * 60_000),
            { type: "usage", kind: "cache_warm", timestamp: new Date(Date.now() - 60_000).toISOString() },
        ]),
    );
    assert.equal(h.notices.length, 1);
    h.select(event, h.ctx(190_000, [response(6 * 60_000, { stopReason: "error" }), response(60_000)]));
    assert.equal(h.notices.length, 2, "a failed response never touched the cache");
    h.select(event, h.ctx(190_000, []));
    assert.equal(h.notices.length, 3, "unknown age: warn rather than guess");
});

test("/bedrock-profiles shows the 5-minute and 1-hour cache write rates, and says when a model has no 1-hour tier", async () => {
    const commands = new Map<string, any>(),
        notices: string[] = [];
    const pi: any = { registerCommand: (name: string, c: any) => commands.set(name, c), on() {} };
    const model = (name: string, foundation: string, cost: object) => ({
        name,
        arn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/x",
        rateSource: "usage program",
        cost,
        promptCache: promptCacheFor(foundation),
    });
    const models = [
        model("Opus", "anthropic.claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }),
        model("Nova", "amazon.nova-pro-v1:0", { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 }),
        model("Other", "openai.gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }),
    ];
    registerStatisticsCommands(pi, {
        config: {
            team: "t",
            profile: "p",
            regions: ["us-east-1"],
            usageDir: "/x",
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        statistics: {} as any,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        models: () => models as any,
        budget: {} as any,
        publish() {},
    });
    await commands
        .get("bedrock-profiles")
        .handler("", { mode: "rpc", ui: { notify: (text: string) => notices.push(text) } });
    assert.match(notices[0]!, /Opus .*cache read \$0\.2, write \$5 \(5 min\) \/ \$8 \(1 h\)/);
    assert.match(notices[0]!, /Nova .*cache read \$0\.2, write \$0\.8 \(5 min only\)/);
    assert.match(notices[0]!, /Other .*cache read \$0\.01, write \$0\.125(?! \()/);
});
