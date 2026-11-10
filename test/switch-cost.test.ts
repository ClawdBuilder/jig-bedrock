import assert from "node:assert/strict";
import test from "node:test";
import { cacheWriteRate, promptCacheFor, retentionFor, retentionOf } from "../src/prompt-cache.ts";
import { registerSwitchNotice, switchNotice, tokensLabel } from "../src/switch-cost.ts";

type Hook = (...args: any[]) => any;

const opus = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 5 };
test("retention follows PI_CACHE_RETENTION exactly as Pi's Bedrock stream reads it", () => {
    assert.equal(retentionOf({}), "short");
    assert.equal(retentionOf({ PI_CACHE_RETENTION: "long" }), "long");
    assert.equal(retentionOf({ PI_CACHE_RETENTION: "short" }), "short");
    assert.equal(retentionOf({ PI_CACHE_RETENTION: "LONG" }), "short");
});
test("the Messages route sends 5-minute checkpoints whatever PI_CACHE_RETENTION says; Converse follows it", () => {
    const long = { PI_CACHE_RETENTION: "long" };
    assert.equal(retentionFor({ api: "anthropic-messages" }, long), "short");
    assert.equal(retentionFor({ api: "bedrock-converse-stream" }, long), "long");
    assert.equal(retentionFor({}, long), "long");
    assert.equal(retentionFor(undefined, {}), "short");
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
test("a Messages-route model has no 1-hour cache: the notice prices the 5-minute write, and its old cache lives 5 minutes", () => {
    const h = harness({ PI_CACHE_RETENTION: "long" });
    const messages = (id: string) =>
        h.model(id, {
            api: "anthropic-messages",
            promptCache: promptCacheFor("anthropic.claude-opus-5-5", "messages"),
        });
    // The target is on Messages: 190k tokens at the 5-minute rate (5 per million), not twice the input rate (10).
    h.select(
        { model: messages("opus"), previousModel: h.model("sonnet"), source: "set" },
        h.ctx(190_000, [response(30 * 60_000)]),
    );
    assert.match(h.notices[0] ?? "", /about \$0\.95/);
    // The old model is on Messages: its cache lasted 5 minutes whatever the setting says, so 30 minutes later it is gone.
    h.select(
        { model: h.model("opus"), previousModel: messages("sonnet"), source: "set" },
        h.ctx(190_000, [response(30 * 60_000)]),
    );
    assert.equal(h.notices.length, 1, "an expired cache needs no warning");
    h.select(
        { model: h.model("opus"), previousModel: messages("sonnet"), source: "set" },
        h.ctx(190_000, [response(2 * 60_000)]),
    );
    assert.match(h.notices[1] ?? "", /about \$1\.90/, "a Converse target still writes the hour");
});
