import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBudget } from "../src/budget.ts";
import { registerStatisticsCommands } from "../src/commands.ts";
import { createStatistics, parseUsage, type UsagePeriod } from "../src/statistics.ts";
import { runUsage, UsageError } from "../src/usage.ts";

type Hook = (...args: any[]) => any;

function directory(t: any) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-statistics-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const config = {
    team: "Fixture Team",
    profile: "fixture-profile",
    regions: ["us-east-1", "us-west-2"],
    usageDir: "/missing",
    ssoLoginCommand: ["fixture"],
    signInAtStart: false,
};
function report(period: UsagePeriod = "monthly", cost: number | null = 1.25) {
    return {
        schema_version: 1,
        command: "usage",
        user: "fixture-user",
        period: { monthly: "Current Month", daily: "Today", weekly: "Last 7 Days" }[period],
        summary: {
            total_requests: 2,
            total_input_tokens_fresh: 3,
            total_cache_read_tokens: 4,
            total_cache_write_tokens: 5,
            total_input_tokens: 12,
            total_output_tokens: 6,
            total_estimated_cost_usd: cost,
        },
        profiles: [
            {
                user: "fixture-user",
                model_slug: "fixture-model",
                profile_name: "fixture-profile",
                requests: 2,
                input_tokens_fresh: 3,
                cache_read_tokens: 4,
                cache_write_tokens: 5,
                total_input_tokens: 12,
                output_tokens: 6,
                estimated_cost_usd: cost,
                private_canary: "never-copy",
            },
        ],
    };
}
test("usage program v1 and explicit legacy reports normalize only known fields and preserve null pricing", () => {
    const source = report("weekly", null),
        parsed = parseUsage(JSON.stringify(source), "weekly");
    assert.equal(parsed.contract, "v1");
    assert.equal(parsed.totals.costUsd, null);
    assert.equal(parsed.totals.cacheRead, 4);
    assert.doesNotMatch(JSON.stringify(parsed), /never-copy|private_canary/);
    const { schema_version, command, ...legacy } = source;
    assert.equal(parseUsage(`Old usage program header\n${JSON.stringify(legacy)}`, "weekly").contract, "legacy");
    const empty = parseUsage(JSON.stringify({ user: "fixture-user", period: "Today", profiles: [] }), "daily");
    assert.equal(empty.totals.requests, 0);
    assert.equal(empty.totals.costUsd, null);
    for (const invalid of [
        { ...source, schema_version: 2 },
        { ...source, command: "profiles" },
        { ...source, period: "Today" },
        { ...source, summary: { ...source.summary, total_requests: "2" } },
        { ...source, summary: { ...source.summary, total_input_tokens: 99 } },
        { ...source, summary: { ...source.summary, total_requests: 3 } },
        { ...source, summary: { ...source.summary, total_estimated_cost_usd: 0 } },
        { ...source, user: "private\ncanary" },
        { ...source, profiles: [{ ...source.profiles[0], user: "another-user" }] },
    ])
        assert.throws(
            () => parseUsage(JSON.stringify(invalid), "weekly"),
            (error: unknown) => error instanceof UsageError && error.kind === "invalid_result",
        );
    assert.throws(() => parseUsage(`header\n${JSON.stringify(source)}`, "weekly"), /unsupported/);
    assert.throws(() => parseUsage("x".repeat(2_097_153), "weekly"), /unsupported/);
});
test("a real usage program executable receives closed argv and explicit regions; cache has only normalized private data", async (t) => {
    const dir = directory(t),
        marker = join(dir, "argv.json"),
        output = join(dir, "report.json"),
        usage = join(dir, "usage");
    writeFileSync(output, JSON.stringify(report("daily")));
    writeFileSync(
        usage,
        `#!${process.execPath}\nconst fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),regions:process.env.BEDROCK_REGIONS,profile:process.env.AWS_PROFILE,skipUpdate:process.env.PAT_SKIP_UPDATE_CHECK})); process.stdout.write(fs.readFileSync(${JSON.stringify(output)}));`,
        { mode: 0o700 },
    );
    const source = createStatistics({ ...config, usageDir: dir }, undefined, dir);
    const snapshot = await source.refresh("daily", { force: true });
    assert.equal(snapshot.report.totals.requests, 2);
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), {
        args: ["usage", "--daily", "--output", "json", "--aws-profile", config.profile],
        regions: "us-east-1,us-west-2",
        profile: config.profile,
        skipUpdate: "1",
    });
    assert.equal(statSync(join(dir, "usage-daily.json")).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(join(dir, "usage-daily.json"), "utf8"), /never-copy|private_canary|summary/);
    assert.equal(source.load("monthly"), undefined);
    assert.equal(
        createStatistics({ ...config, usageDir: dir, profile: "other" }, undefined, dir).load("daily"),
        undefined,
    );
    const cache = join(dir, "usage-daily.json"),
        saved = readFileSync(cache, "utf8");
    const future = JSON.parse(saved);
    future.observedAt = Date.now() + 60_000;
    writeFileSync(cache, JSON.stringify(future));
    assert.equal(source.load("daily"), undefined);
    writeFileSync(cache, saved, { mode: 0o600 });
});
test("report scope, UTC rollover and failed refresh are explicit while the last valid estimate survives", async (t) => {
    const dir = directory(t);
    let now = Date.parse("2026-10-31T23:58:00Z"),
        calls = 0,
        fail = false;
    const source = createStatistics(
        config,
        async () => {
            calls++;
            if (fail) throw new Error("private-canary");
            return JSON.stringify(report());
        },
        dir,
        () => now,
    );
    await Promise.all([source.refresh("monthly"), source.refresh("monthly")]);
    assert.equal(calls, 1);
    await source.refresh("monthly");
    assert.equal(calls, 1);
    fail = true;
    await assert.rejects(source.refresh("monthly", { force: true }), /usage program statistics unavailable/);
    assert.equal(source.load("monthly")?.stale, true);
    assert.equal(source.load("monthly")?.refreshFailed, true);
    assert.equal(source.load("monthly")?.report.totals.costUsd, 1.25);
    assert.doesNotMatch(readFileSync(join(dir, "usage-monthly.json"), "utf8"), /private-canary/);
    now = Date.parse("2026-11-01T00:00:00Z");
    assert.equal(source.load("monthly"), undefined);
});
test("a request crossing a UTC period boundary never labels the previous period as current", async (t) => {
    const dir = directory(t);
    let now = Date.parse("2026-10-31T23:59:59Z");
    const source = createStatistics(
        config,
        async () => {
            now += 2000;
            return JSON.stringify(report());
        },
        dir,
        () => now,
    );
    await assert.rejects(
        source.refresh("monthly", { force: true }),
        (error: unknown) => error instanceof UsageError && error.kind === "invalid_result",
    );
    assert.equal(source.load("monthly"), undefined);
});
test("usage program process bounds timeout, cancellation and bytes without leaking child output", async (t) => {
    const dir = directory(t),
        script = join(dir, "usage");
    writeFileSync(
        script,
        `#!${process.execPath}\nconsole.error("private-canary-device-code"); setTimeout(()=>{}, 10000);`,
        { mode: 0o700 },
    );
    await assert.rejects(
        runUsage(script, [], { timeout: 30, maxBuffer: 100 }),
        (error: unknown) =>
            error instanceof UsageError && error.kind === "timeout" && !error.message.includes("private-canary"),
    );
    const abort = new AbortController(),
        pending = runUsage(script, [], { timeout: 5000, maxBuffer: 100, signal: abort.signal });
    abort.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof UsageError && error.kind === "cancelled");
    writeFileSync(script, `#!${process.execPath}\nprocess.stdout.write("x".repeat(101));`, { mode: 0o700 });
    await assert.rejects(
        runUsage(script, [], { timeout: 5000, maxBuffer: 100 }),
        (error: unknown) => error instanceof UsageError && error.kind === "invalid_result",
    );
    await assert.rejects(
        runUsage(join(dir, "absent"), [], { timeout: 5000, maxBuffer: 100 }),
        (error: unknown) => error instanceof UsageError && error.kind === "missing",
    );
});
test("monthly budget shares statistics and counts a newly unpriced row as unpriced instead of dropping the spend figure", async (t) => {
    const dir = directory(t);
    let calls = 0,
        price: number | null = 1.25;
    const source = createStatistics(
        config,
        async () => {
            calls++;
            return JSON.stringify(report("monthly", price));
        },
        dir,
    );
    const budget = createBudget(config, undefined, join(dir, "budget.json"), Date.now, source);
    await source.refresh("monthly", { force: true });
    await budget.refresh({ force: true });
    assert.equal(calls, 1);
    assert.equal(budget.load()?.spentUsd, 1.25);
    assert.equal(budget.load()?.unpriced, false);
    assert.equal(budget.load()?.limitUsd, undefined);
    price = null;
    await source.refresh("monthly", { force: true });
    await budget.refresh({ force: true });
    assert.equal(calls, 2);
    assert.equal(budget.load()?.spentUsd, 0);
    assert.equal(budget.load()?.unpriced, true);
});
function commands(t: any, runner?: any) {
    const dir = directory(t),
        source = createStatistics(config, runner ?? (async () => JSON.stringify(report())), dir),
        commands = new Map<string, any>(),
        hooks = new Map<string, Hook>(),
        notifications: string[] = [];
    const pi: any = {
        registerCommand: (name: string, command: any) => commands.set(name, command),
        on: (name: string, handler: Hook) => hooks.set(name, handler),
        sendMessage: () => assert.fail("No model message"),
        sendUserMessage: () => assert.fail("No user message"),
    };
    const budget = createBudget(config, undefined, join(dir, "budget.json"), Date.now, source);
    registerStatisticsCommands(pi, {
        config,
        statistics: source,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        models: () => [],
        budget,
        publish() {},
    });
    const ctx: any = {
        mode: "rpc",
        sessionManager: {
            getBranch: () => [
                {
                    type: "message",
                    message: {
                        role: "assistant",
                        provider: "jig-bedrock",
                        usage: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6, cost: { total: 0.2 } },
                    },
                },
            ],
        },
        ui: { notify: (text: string) => notifications.push(text) },
    };
    return { commands, hooks, notifications, ctx };
}
test("slash commands validate closed arguments and display separate local and usage program estimates without model messages", async (t) => {
    let calls = 0;
    const h = commands(t, async () => {
        calls++;
        return JSON.stringify(report());
    });
    assert.deepEqual([...h.commands.keys()], ["bedrock-usage", "bedrock-stats", "bedrock-profiles", "bedrock-doctor"]);
    await h.commands.get("bedrock-usage").handler("monthly --aws-profile other", h.ctx);
    assert.equal(calls, 0);
    assert.match(h.notifications.pop()!, /Usage:/);
    await h.commands.get("bedrock-stats").handler("", h.ctx);
    assert.equal(calls, 1);
    const text = h.notifications.pop()!;
    assert.match(text, /Current Pi branch/);
    assert.match(text, /Pi estimated cost: \$0.2000/);
    assert.match(text, /usage program user estimate/);
    assert.match(text, /not a team total/);
    assert.match(text, /Cache read 4/);
    assert.doesNotMatch(text, /never-copy/);
    const originalPath = process.env.PATH;
    process.env.PATH = directory(t);
    try {
        await h.commands.get("bedrock-doctor").handler("", h.ctx);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
    }
    assert.equal(calls, 1);
    assert.match(h.notifications.pop()!, /no AWS calls/);
});
test("closing the native statistics dialog cancels its usage program work", async (t) => {
    let aborted = false;
    const h = commands(
        t,
        async (_program: string, _args: string[], options: any) =>
            new Promise((_resolve, reject) =>
                options.signal.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                        reject(new UsageError("cancelled"));
                    },
                    { once: true },
                ),
            ),
    );
    h.ctx.mode = "tui";
    h.ctx.ui.custom = (factory: any) =>
        new Promise<void>((resolve) => {
            const component = factory(
                { terminal: { rows: 20 }, requestRender() {} },
                { fg: (_role: string, value: string) => value },
                {},
                resolve,
            );
            assert.ok(component.render(60).every((row: string) => row.length <= 60));
            setTimeout(() => component.handleInput("q"), 10);
        });
    await h.commands.get("bedrock-usage").handler("monthly", h.ctx);
    assert.equal(aborted, true);
});

test("priced profile costs reconcile with the summary while unresolved models remain unknown", () => {
    const mismatch = report();
    mismatch.summary.total_estimated_cost_usd = 999;
    assert.throws(() => parseUsage(JSON.stringify(mismatch), "monthly"), /unsupported/);
    const floating = report("monthly", 0.3);
    floating.profiles[0]!.estimated_cost_usd = 0.1 + 0.2;
    assert.equal(parseUsage(JSON.stringify(floating), "monthly").totals.costUsd, 0.3);
    const unknown = report("monthly", null);
    unknown.profiles[0]!.model_slug = "";
    const parsed = parseUsage(JSON.stringify(unknown), "monthly");
    assert.equal(parsed.profiles[0]!.model, "Unknown model");
    assert.equal(parsed.totals.costUsd, null);
});
