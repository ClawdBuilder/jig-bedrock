import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBudget, parseBudget } from "../src/budget.ts";
import { usageLines } from "../src/commands.ts";
import { createJigBedrock } from "../src/provider.ts";
import { createStatistics, parseUsage, pricedSpend } from "../src/statistics.ts";

type Hook = (...args: any[]) => any;

const config = {
    team: "Fixture Team",
    profile: "fixture-profile",
    regions: ["us-east-1"],
    usageDir: "/missing",
    ssoLoginCommand: ["fixture"],
    signInAtStart: false,
    monthlyBudgetUsd: 200,
};
function directory(t: any) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-budget-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
// The month's shape on the user's machine: several priced models and one (a new OpenAI model) usage program has no rate for.
const rows = [
    ["claude-opus-5-5", 126.11],
    ["claude-opus-5", 52.16],
    ["claude-sonnet-5-5", 27.12],
    ["claude-haiku-4-5", 1.37],
    ["gpt-6-luna", null],
] as const;
function monthly(list: readonly (readonly [string, number | null])[] = rows) {
    const priced = list.filter(([, cost]) => cost !== null).reduce((sum, [, cost]) => sum + cost!, 0);
    const profiles = list.map(([model, cost]) => ({
        user: "fixture-user",
        model_slug: model,
        profile_name: `team-${model}`,
        requests: 2,
        input_tokens_fresh: 3,
        cache_read_tokens: 4,
        cache_write_tokens: 5,
        total_input_tokens: 12,
        output_tokens: 6,
        estimated_cost_usd: cost,
    }));
    // usage program leaves the summary cost null when any row is unpriced.
    const unpriced = list.some(([, cost]) => cost === null);
    return JSON.stringify({
        user: "fixture-user",
        period: "Current Month",
        summary: {
            total_requests: 2 * list.length,
            total_input_tokens_fresh: 3 * list.length,
            total_cache_read_tokens: 4 * list.length,
            total_cache_write_tokens: 5 * list.length,
            total_input_tokens: 12 * list.length,
            total_output_tokens: 6 * list.length,
            total_estimated_cost_usd: unpriced ? null : priced,
        },
        profiles,
    });
}

test("an unpriced row no longer hides the month's priced spend; the figure is flagged instead", () => {
    const report = parseUsage(monthly(), "monthly");
    assert.equal(report.totals.costUsd, null);
    const spend = pricedSpend(report);
    assert.ok(Math.abs(spend.spentUsd - 206.76) < 1e-9);
    assert.equal(spend.unpriced, true);
    const budget = parseBudget(monthly(), "2026-10", Date.parse("2026-10-16T12:00:00Z"), 200);
    assert.ok(Math.abs(budget.spentUsd - 206.76) < 1e-9);
    assert.equal(budget.unpriced, true);
    assert.ok(budget.remainingUsd! < 0);
    const clean = parseBudget(monthly(rows.slice(0, 4)), "2026-10", Date.parse("2026-10-16T12:00:00Z"));
    assert.equal(clean.unpriced, false);
    assert.equal(clean.limitUsd, undefined);
    assert.equal(
        pricedSpend(
            parseUsage(JSON.stringify({ user: "fixture-user", period: "Current Month", profiles: [] }), "monthly"),
        ).spentUsd,
        0,
    );
});
test("the cached budget keeps the sum and the flag, and refuses a month or scope it was not written for", async (t) => {
    const dir = directory(t);
    let now = Date.parse("2026-10-16T12:00:00Z");
    const source = createStatistics(
            config,
            async () => monthly(),
            dir,
            () => now,
        ),
        file = join(dir, "budget.json");
    const budget = createBudget(config, undefined, file, () => now, source);
    await budget.refresh();
    const loaded = budget.load()!;
    assert.ok(Math.abs(loaded.spentUsd - 206.76) < 1e-9);
    assert.equal(loaded.unpriced, true);
    assert.equal(loaded.limitUsd, 200);
    assert.equal(loaded.monthUtc, "2026-10");
    assert.equal(loaded.refreshFailed, false);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).unpriced, true);
    now = Date.parse("2026-11-01T00:00:01Z");
    assert.equal(budget.load(), undefined);
    assert.equal(
        createBudget(
            { ...config, team: "Other" },
            undefined,
            file,
            () => Date.parse("2026-10-16T12:00:00Z"),
            source,
        ).load(),
        undefined,
    );
});
test("a failed usage program refresh keeps the known figure, or recovers it from the last valid monthly report", async (t) => {
    const dir = directory(t);
    let now = Date.parse("2026-10-16T12:00:00Z"),
        fail = false;
    const source = createStatistics(
            config,
            async () => {
                if (fail) throw new Error("private-canary");
                return monthly();
            },
            dir,
            () => now,
        ),
        file = join(dir, "budget.json");
    const budget = createBudget(config, undefined, file, () => now, source);
    await source.refresh("monthly", { force: true });
    // budget.json has no figure yet (an older version wrote none for an unpriced month) but the monthly report is cached.
    writeFileSync(
        file,
        JSON.stringify({
            schema: 1,
            scope: JSON.stringify({
                profile: config.profile,
                team: config.team,
                regions: config.regions,
                usageDir: config.usageDir,
            }),
            profile: config.profile,
            monthUtc: "2026-10",
            lastAttemptAt: 1,
            refreshFailed: true,
        }),
        { mode: 0o600 },
    );
    assert.equal(budget.load(), undefined);
    now += 600_000;
    fail = true;
    await budget.refresh();
    const recovered = budget.load()!;
    assert.ok(Math.abs(recovered.spentUsd - 206.76) < 1e-9);
    assert.equal(recovered.unpriced, true);
    assert.equal(recovered.refreshFailed, true);
    assert.doesNotMatch(readFileSync(file, "utf8"), /private-canary|summary/);
});
test("the usage report shows the priced rows as a lower bound instead of an unknown total", () => {
    const report = parseUsage(monthly(), "monthly");
    const text = usageLines({ report, observedAt: Date.now(), stale: false, refreshFailed: false }).join("\n");
    assert.match(text, /Estimated cost: \$206\.7600 \+ unpriced usage/);
    const none = parseUsage(monthly([["gpt-6-luna", null]]), "monthly");
    assert.match(
        usageLines({ report: none, observedAt: Date.now(), stale: false, refreshFailed: false }).join("\n"),
        /Estimated cost: unknown \(unpriced usage\)/,
    );
});
test("the usage event carries the sum and the unpriced flag for the footer", async (t) => {
    const dir = directory(t),
        hooks = new Map<string, Hook[]>(),
        emitted: any[] = [];
    const budget = {
        monthUtc: "2026-10",
        spentUsd: 206.76,
        unpriced: true,
        limitUsd: 200,
        remainingUsd: -6.76,
        observedAt: 1,
        refreshFailed: false,
    };
    const pi: any = {
        on: (name: string, fn: Hook) => hooks.set(name, [...(hooks.get(name) || []), fn]),
        registerProvider() {},
        registerCommand() {},
        events: { emit: (channel: string, data: any) => emitted.push({ channel, data }) },
        setModel: () => false,
    };
    await createJigBedrock({
        config: { ...config, agentDir: dir, usageDir: dir },
        catalog: { load: () => undefined, refresh: async () => "ok" },
        ssoRecover: async () => {},
        budget: { load: () => budget, refresh: async () => {} },
        backgroundRefresh: false,
    })(pi);
    const ctx: any = {
        mode: "rpc",
        model: undefined,
        sessionManager: { getBranch: () => [], getSessionId: () => "session" },
        ui: { notify() {} },
        modelRegistry: { find: () => undefined },
    };
    for (const fn of hooks.get("session_start") || []) await fn({ type: "session_start" }, ctx);
    const usage = emitted.find((e) => e.channel === "jig-bedrock:usage");
    assert.deepEqual(usage.data, { sessionId: "session", budget });
});
