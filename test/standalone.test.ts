import assert from "node:assert/strict";
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { category, createAwsDiscovery, discoveryHelp, type Runner } from "../src/aws-discovery.ts";
import { createBudget, parseBudget } from "../src/budget.ts";
import { bedrockStream, discoveredProfiles, registerBedrockSelectionGuard, usePiRegistry } from "../src/catalog.ts";
import { checkBedrock, loadConfig } from "../src/config.ts";
import { createRecovery } from "../src/login.ts";
import { createJigBedrock } from "../src/provider.ts";
import { elsewhere } from "./support/wsl.ts";

type Hook = (...args: any[]) => any;
/** The settings from a `bedrock` section (or none) and an environment, as the provider resolves them. */
const resolveConfig = (raw: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = {}) =>
    loadConfig({ raw, env }).config;
const config = {
    team: "fixture-team",
    profile: "fixture-profile",
    regions: ["us-east-1", "us-west-2"],
    usageDir: "/missing-usage",
    ssoLoginCommand: ["fixture", "{profile}"],
    signInAtStart: false,
};
const account = "123456789012",
    arn = (id = "one", region = "us-east-1") =>
        `arn:aws:bedrock:${region}:${account}:application-inference-profile/${id}`;
function directory(t: any) {
    const dir = mkdtempSync(join(tmpdir(), "standalone-bedrock-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function fixture() {
    const calls: string[][] = [];
    const state = { fail: "", empty: false, account, paginated: true };
    const runner: Runner = async (program, args, options) => {
        assert.equal(program, "aws");
        assert.ok(options.timeout <= 20000);
        assert.ok(options.maxBuffer <= 1048576);
        calls.push(args);
        const region = args[args.indexOf("--region") + 1];
        if (args.includes("get-caller-identity")) return JSON.stringify({ Account: state.account });
        if (state.fail && region === "us-west-2") throw new Error(state.fail);
        if (args.includes("get-resources")) {
            assert.deepEqual(JSON.parse(args[args.indexOf("--tag-filters") + 1]!), [
                { Key: "Team", Values: ["fixture-team"] },
                { Key: "Active", Values: ["true"] },
            ]);
            assert.ok(args.includes("--no-paginate"));
            if (state.empty || region === "us-west-2") return JSON.stringify({ ResourceTagMappingList: [] });
            const next = args.includes("--pagination-token");
            return JSON.stringify({
                ResourceTagMappingList: [
                    {
                        ResourceARN: arn(next ? "two" : "one"),
                        Tags: [
                            { Key: "Team", Value: config.team },
                            { Key: "Active", Value: "true" },
                        ],
                    },
                ],
                ...(!next && state.paginated ? { PaginationToken: "next" } : {}),
            });
        }
        return JSON.stringify({
            status: args.includes(arn("two")) ? "INACTIVE" : "ACTIVE",
            inferenceProfileName: "Fixture",
            models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/fixture.model" }],
        });
    };
    return { calls, state, runner };
}
test("discovery paginates all regions, filters ACTIVE and atomically caches normalized metadata", async (t) => {
    const f = fixture(),
        file = join(directory(t), "catalog.json"),
        source = createAwsDiscovery(config, f.runner, file);
    assert.equal(await source.refresh(), "ok");
    assert.equal(source.load()?.profiles.length, 1);
    assert.equal(source.load()?.profiles[0]?.foundation_model_id, "fixture.model");
    assert.equal(f.calls.filter((a) => a.includes("get-resources")).length, 3);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, "utf8"), /ResourceTagMappingList|modelArn/);
});
test("catalog TTL, single flight, empty catalogs and partial failure preserve the contract", async (t) => {
    const f = fixture(),
        file = join(directory(t), "catalog.json");
    let now = Date.now();
    const source = createAwsDiscovery(config, f.runner, file, () => now);
    const first = source.refresh();
    assert.equal(first, source.refresh());
    await first;
    const bytes = readFileSync(file, "utf8"),
        count = f.calls.length;
    await source.refresh();
    assert.equal(f.calls.length, count, "a catalog younger than the TTL costs no AWS call, not even STS");
    await source.refresh(true);
    assert.equal(
        f.calls.filter((a) => a.includes("get-caller-identity")).length,
        2,
        "an explicit refresh checks the caller again",
    );
    f.state.fail = "Could not connect";
    assert.equal(await source.refresh(true), "network");
    assert.equal(readFileSync(file, "utf8"), bytes);
    f.state.fail = "SSO token expired";
    assert.equal(await source.refresh(true), "sso_expired");
    assert.equal(readFileSync(file, "utf8"), bytes);
    f.state.fail = "";
    f.state.empty = true;
    now += 86400001;
    assert.equal(await source.refresh(), "ok");
    assert.deepEqual(source.load()?.profiles, []);
});
test("scope and caller-account changes invalidate cached approvals even on partial failure", async (t) => {
    const f = fixture(),
        file = join(directory(t), "catalog.json"),
        source = createAwsDiscovery(config, f.runner, file);
    await source.refresh();
    for (const changes of [{ team: "other" }, { profile: "other" }, { regions: ["eu-west-1"] }])
        assert.equal(createAwsDiscovery({ ...config, ...changes }, f.runner, file).load(), undefined);
    f.state.account = "999999999999";
    assert.equal(await source.refresh(true), "unavailable");
    assert.equal(source.load(), undefined);
    assert.equal(createAwsDiscovery(config, f.runner, file).load(), undefined);
});
test("discovery bounds bytes, pagination and deadline and never publishes raw failure text", async (t) => {
    const file = join(directory(t), "catalog.json");
    assert.equal(await createAwsDiscovery(config, async () => "x".repeat(1048577), file).refresh(), "unavailable");
    const f = fixture();
    let now = Date.now();
    assert.equal(
        await createAwsDiscovery(
            config,
            async (...args) => {
                now += 91000;
                return f.runner(...args);
            },
            file,
            () => now,
        ).refresh(),
        "timeout",
    );
    assert.equal(
        await createAwsDiscovery(
            config,
            async () => {
                throw new Error("private-canary");
            },
            file,
        ).refresh(),
        "unavailable",
    );
    let calls = 0;
    const repeating: Runner = async (_program, args) => {
        calls++;
        return JSON.stringify(
            args.includes("get-caller-identity")
                ? { Account: account }
                : { ResourceTagMappingList: [], PaginationToken: "same" },
        );
    };
    assert.equal(await createAwsDiscovery(config, repeating, file).refresh(), "unavailable");
    assert.ok(calls <= 3);
});
test("config precedence and invalid or missing teams fail closed without throwing", () => {
    assert.equal(resolveConfig(undefined), undefined);
    const section = { team: "file-team", profile: "file-profile", regions: ["us-west-2"], monthlyBudgetUsd: 25 };
    const c = resolveConfig(section, {
        JIG_BEDROCK_TEAM: "env-team",
        JIG_BEDROCK_PROFILE: "env-profile",
        JIG_BEDROCK_REGIONS: "eu-west-1",
        JIG_BEDROCK_USAGE_DIR: "/explicit-usage",
    })!;
    assert.equal(c.team, "env-team");
    assert.equal(c.profile, "env-profile");
    assert.deepEqual(c.regions, ["eu-west-1"]);
    assert.equal(c.monthlyBudgetUsd, 25);
    assert.equal(c.usageDir, "/explicit-usage");
    // The section alone, with the package defaults filling the rest.
    const plain = resolveConfig(section)!;
    assert.deepEqual(
        [plain.team, plain.profile, plain.regions, plain.monthlyBudgetUsd],
        ["file-team", "file-profile", ["us-west-2"], 25],
    );
    assert.deepEqual(resolveConfig({ team: "t" })!.ssoLoginCommand, ["aws", "sso", "login", "--profile", "{profile}"]);
    assert.equal(resolveConfig({ team: "t" })!.profile, "my-bedrock-profile");
    assert.equal(resolveConfig({ team: "t" })!.usageDir, "~/.local/share/usage-tool");
    for (const team of ["", " ", "bad\nteam", "x".repeat(257)])
        assert.equal(resolveConfig(undefined, { JIG_BEDROCK_TEAM: team }), undefined);
    assert.equal(
        resolveConfig(undefined, { JIG_BEDROCK_TEAM: "Platform / Core, Europe" })?.team,
        "Platform / Core, Europe",
    );
    assert.equal(resolveConfig({ team: "fixture", ssoLoginCommand: ["aws", "{token}"] }), undefined);
    assert.match(loadConfig({ raw: undefined, env: {} }).error!, /Set bedrock\.team in the bedrock settings/);
});
test("configuration diagnostics identify invalid fields without exposing their contents", () => {
    for (const [value, expected] of [
        [{ team: "fixture", typo: "private-canary" }, /Unknown field/],
        [{ team: "fixture", profile: "private-canary\n" }, /profile must/],
        [{ team: "fixture", regions: ["us-east-1", "us-east-1"] }, /regions must/],
        [{ team: "fixture", monthlyBudgetUsd: "private-canary" }, /monthlyBudgetUsd must/],
        [{ team: "fixture", ssoLoginCommand: ["private-canary", "{token}"] }, /argv array/],
    ] as const) {
        const result = loadConfig({ raw: value, env: {} });
        assert.equal(result.config, undefined);
        assert.match(result.error!, expected);
        assert.doesNotMatch(result.error!, /private-canary/);
    }
});
test("the bedrock section is checked when jig.json is read: each problem names its key and none repeats a value", () => {
    const errors = (raw: unknown): string[] => {
        const found: string[] = [];
        checkBedrock(raw, found);
        return found;
    };
    assert.deepEqual(errors({ team: "Platform / Core, Europe", monthlyBudgetUsd: 200 }), []);
    assert.deepEqual(
        errors({
            team: "t",
            profile: "p",
            regions: ["us-east-1", "eu-west-1"],
            usageDir: "~/usage",
            ssoLoginCommand: ["aws", "sso", "login", "--profile", "{profile}"],
        }),
        [],
    );
    assert.match(errors({}).join("\n"), /bedrock\.team must be your exact AWS tag value/);
    assert.match(errors({ team: "t", typo: "private-canary" }).join("\n"), /bedrock\.typo is not a known field/);
    assert.match(
        errors({ team: "t", profile: "bad profile" }).join("\n"),
        /bedrock\.profile must be an AWS profile name/,
    );
    assert.match(
        errors({ team: "t", regions: [] }).join("\n"),
        /bedrock\.regions must contain 1-16 unique AWS region names/,
    );
    assert.match(
        errors({ team: "t", monthlyBudgetUsd: 0 }).join("\n"),
        /monthlyBudgetUsd must be a positive finite number/,
    );
    assert.match(
        errors({ team: "t", ssoLoginCommand: ["aws", "{token}"] }).join("\n"),
        /ssoLoginCommand must be an argv array/,
    );
    assert.match(errors("private-canary").join("\n"), /bedrock must be an object/);
    for (const raw of [
        { team: "private-canary\n" },
        { team: "t", profile: "private-canary\n" },
        { team: "t", monthlyBudgetUsd: "private-canary" },
    ]) {
        assert.doesNotMatch(errors(raw).join("\n"), /private-canary/);
    }
});
test("discovery rejects returned tags outside the configured team and safely distinguishes setup failures", async (t) => {
    const f = fixture(),
        file = join(directory(t), "catalog.json");
    const source = createAwsDiscovery(
        config,
        async (...args) => {
            const value = JSON.parse(await f.runner(...args));
            if (value.ResourceTagMappingList?.length) value.ResourceTagMappingList[0].Tags[0].Value = "other-team";
            return JSON.stringify(value);
        },
        file,
    );
    assert.equal(await source.refresh(), "unavailable");
    assert.equal(source.load(), undefined);
    for (const [error, status, help] of [
        ["AccessDeniedException private-canary", "permission_denied", /administrator/],
        ["The config profile (private-canary) could not be found", "configuration", /profile/],
        ["spawn aws ENOENT private-canary", "configuration", /PATH/],
        ["SSO token expired private-canary", "sso_expired", /aws-login/],
        ["Could not connect private-canary", "network", /network/],
    ] as const) {
        const result = await createAwsDiscovery(
            config,
            async () => {
                throw new Error(error);
            },
            file,
        ).refresh();
        assert.equal(result, status);
        assert.equal(category(new Error(error)), status);
        assert.match(discoveryHelp(result), help);
        assert.doesNotMatch(discoveryHelp(result), /private-canary/);
    }
});
test("team tag punctuation is passed as one JSON argv value", async (t) => {
    const team = "Platform / Core, Europe",
        file = join(directory(t), "catalog.json");
    const source = createAwsDiscovery(
        { ...config, team },
        async (_program, args) => {
            if (args.includes("get-caller-identity")) return JSON.stringify({ Account: account });
            assert.deepEqual(JSON.parse(args[args.indexOf("--tag-filters") + 1]!), [
                { Key: "Team", Values: [team] },
                { Key: "Active", Values: ["true"] },
            ]);
            return JSON.stringify({ ResourceTagMappingList: [] });
        },
        file,
    );
    assert.equal(await source.refresh(), "ok");
    assert.equal(source.load()?.team, team);
});
test("missing team emits one notice without AWS, usage program or provider registration", async (t) => {
    const dir = directory(t);
    const hooks = new Map<string, Hook[]>(),
        notices: string[] = [];
    await createJigBedrock({ env: { PI_CODING_AGENT_DIR: dir }, selection: { agentDir: dir } })({
        on: (name: string, fn: Hook) => hooks.set(name, [...(hooks.get(name) || []), fn]),
        registerProvider: () => assert.fail("provider"),
        setModel: () => false,
    } as any);
    const ctx = { sessionManager: { getBranch: () => [] }, ui: { notify: (s: string) => notices.push(s) } };
    for (const fn of hooks.get("session_start") || []) await fn({}, ctx);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /Edit bedrock in jig\.json/);
});
test("usage program parse and scoped cache throttle refresh and preserve last good spend", async (t) => {
    let now = Date.now(),
        calls = 0,
        fail = false;
    const report =
        "shell preamble\n" +
        JSON.stringify({
            user: "fixture",
            period: "Current Month",
            summary: {
                total_requests: 1,
                total_input_tokens_fresh: 2,
                total_cache_read_tokens: 3,
                total_cache_write_tokens: 4,
                total_input_tokens: 9,
                total_output_tokens: 5,
                total_estimated_cost_usd: 12.5,
            },
            profiles: [
                {
                    user: "fixture",
                    model_slug: "fixture-model",
                    profile_name: "fixture-profile",
                    requests: 1,
                    input_tokens_fresh: 2,
                    cache_read_tokens: 3,
                    cache_write_tokens: 4,
                    total_input_tokens: 9,
                    output_tokens: 5,
                    estimated_cost_usd: 12.5,
                },
            ],
        });
    const file = join(directory(t), "budget.json"),
        budget = createBudget(
            { ...config, monthlyBudgetUsd: 100 },
            async (_program, args) => {
                calls++;
                assert.equal(args.at(-1), config.profile);
                if (fail) throw new Error("secret");
                return report;
            },
            file,
            () => now,
        );
    assert.equal(parseBudget(report, new Date(now).toISOString().slice(0, 7), now).limitUsd, undefined);
    await Promise.all([budget.refresh(), budget.refresh()]);
    await budget.refresh();
    assert.equal(calls, 1);
    assert.equal(budget.load()?.remainingUsd, 87.5);
    now += 300001;
    fail = true;
    await budget.refresh();
    assert.equal(budget.load()?.spentUsd, 12.5);
    assert.equal(budget.load()?.refreshFailed, true);
    assert.doesNotMatch(readFileSync(file, "utf8"), /secret|summary/);
    assert.equal(
        createBudget(
            { ...config, profile: "other" },
            async () => "",
            file,
            () => now,
        ).load(),
        undefined,
    );
    for (const raw of [true, -1, "12"])
        assert.throws(() =>
            parseBudget(
                JSON.stringify({ period: "Current Month", summary: { total_estimated_cost_usd: raw } }),
                new Date(now).toISOString().slice(0, 7),
                now,
            ),
        );
});
test("SSO lock shares one browser, cleans stale owners, ignores output and bounds abort", async (t) => {
    const dir = directory(t),
        lock = join(dir, "login.lock"),
        marker = join(dir, "calls");
    const script = join(dir, "login.sh");
    writeFileSync(script, `#!/bin/sh\necho x >> '${marker}'\necho private-output\nsleep 0.2\n`, { mode: 0o700 });
    const recovery = createRecovery(
        { ...config, ssoLoginCommand: [script, "{profile}"] },
        { lock, timeoutMs: 5000, wsl: elsewhere },
    );
    await Promise.all([recovery(config.profile), recovery(config.profile)]);
    assert.equal(readFileSync(marker, "utf8"), "x\n");
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, profile: config.profile }), { mode: 0o600 });
    await recovery(config.profile);
    assert.equal(readFileSync(marker, "utf8"), "x\nx\n");
    const abort = new AbortController();
    const pending = recovery(config.profile, abort.signal);
    setTimeout(() => abort.abort(), 10);
    await assert.rejects(pending, /did not complete/);
});
test("standalone stream blocks unknown, removed and cross-scope profiles before transport", async (t) => {
    const f = fixture(),
        file = join(directory(t), "catalog.json"),
        source = createAwsDiscovery(config, f.runner, file);
    await source.refresh();
    usePiRegistry({
        getModels: () => [
            {
                provider: "amazon-bedrock",
                id: "fixture.model",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 1000,
                maxTokens: 100,
                cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
        ],
    } as any);
    const models = discoveredProfiles(source.load(), config.usageDir, "converse").available;
    assert.equal(models.length, 1);
    let calls = 0;
    const stream = bedrockStream(
        models,
        {
            converse: ((m: any, _ctx: any, opts: any) => {
                calls++;
                assert.equal(m.id, arn());
                assert.equal(opts.profile, config.profile);
                return "ok";
            }) as any,
        },
        source.load,
        config.profile,
    );
    assert.equal(stream({ ...models[0], provider: "jig-bedrock" } as any, {} as any), "ok");
    assert.throws(() => stream({ ...models[0], provider: "amazon-bedrock" } as any, {} as any), /Unapproved/);
    assert.throws(
        () => stream({ ...models[0], provider: "jig-bedrock" } as any, {} as any, { env: { AWS_PROFILE: "other" } }),
        /scope/,
    );
    f.state.empty = true;
    await source.refresh(true);
    assert.throws(() => stream({ ...models[0], provider: "jig-bedrock" } as any, {} as any), /Unapproved/);
    assert.equal(calls, 1);
});
test("removed selection blocks after Pi changes model until a user chooses", () => {
    const hooks = new Map<string, Hook>();
    const guard = registerBedrockSelectionGuard(
        { on: (name: string, fn: Hook) => hooks.set(name, fn), setModel: async () => true } as any,
        [],
    );
    const ctx = { model: { provider: "other", id: "other" }, ui: { notify() {} } };
    guard.blockUntilChoice();
    assert.equal(hooks.get("input")!({}, ctx).action, "handled");
    hooks.get("model_select")!({ source: "restore" }, ctx);
    assert.equal(hooks.get("input")!({}, ctx).action, "handled");
    hooks.get("model_select")!({ source: "set" }, ctx);
    assert.equal(hooks.get("input")!({}, ctx).action, "continue");
});

test("saved default comes from the active Pi home and warns once when unavailable", async (t) => {
    const dir = directory(t),
        before = { ...process.env };
    t.after(() => {
        process.env = before;
    });
    writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ defaultProvider: "jig-bedrock", defaultModel: "removed-model" }),
    );
    process.env.PI_CODING_AGENT_DIR = dir;
    const hooks = new Map<string, Hook>(),
        notices: string[] = [];
    registerBedrockSelectionGuard(
        { on: (name: string, fn: Hook) => hooks.set(name, fn), setModel: async () => true } as any,
        [],
    );
    const ctx = {
        model: undefined,
        sessionManager: { getBranch: () => [] },
        modelRegistry: { find: () => undefined },
        ui: { notify: (s: string) => notices.push(s) },
    };
    await hooks.get("session_start")!({}, ctx);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /Saved Bedrock model is unavailable/);
});

test("catalog rejects symlinks, loose permissions, duplicate ARNs and future timestamps", async (t) => {
    const dir = directory(t),
        file = join(dir, "catalog.json"),
        f = fixture();
    const source = createAwsDiscovery(config, f.runner, file);
    await source.refresh();
    const cached = readFileSync(file, "utf8");
    chmodSync(file, 0o644);
    assert.equal(source.load(), undefined);
    chmodSync(file, 0o600);
    for (const changes of [
        { fetched_at: -1 },
        { fetched_at: Math.floor(Date.now() / 1000) + 10 },
        { profiles: [source.load()!.profiles[0], source.load()!.profiles[0]] },
    ]) {
        writeFileSync(file, JSON.stringify({ ...JSON.parse(cached), ...changes }));
        assert.equal(source.load(), undefined);
        writeFileSync(file, cached);
    }
    renameSync(file, join(dir, "real.json"));
    symlinkSync(join(dir, "real.json"), file);
    assert.equal(source.load(), undefined);
    rmSync(file);
    writeFileSync(file, "x".repeat(1048577), { mode: 0o600 });
    assert.equal(source.load(), undefined);
});
test("catalog uses exact registry metadata and usage program pricing without copying unrelated fields", async (t) => {
    const dir = directory(t),
        file = join(dir, "catalog.json"),
        f = fixture();
    const source = createAwsDiscovery(config, f.runner, file);
    await source.refresh();
    usePiRegistry({
        getModels: () => [
            {
                provider: "amazon-bedrock",
                id: "fixture.model",
                name: "Fixture",
                reasoning: true,
                input: ["text"],
                contextWindow: 2000,
                maxTokens: 200,
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                apiKey: "credential-canary",
            },
        ],
    } as any);
    writeFileSync(
        join(dir, "models.json"),
        JSON.stringify([
            {
                key: "fixture",
                pricing: { input: 3, output: 4, cache_read: 1, cache_write: 2 },
                token: "credential-canary",
            },
        ]),
    );
    const found = discoveredProfiles(source.load(), dir);
    assert.equal(found.available[0]!.rateSource, "usage program");
    assert.equal(found.available[0]!.contextWindow, 2000);
    assert.equal(found.available[0]!.cost.input, 3);
    assert.doesNotMatch(JSON.stringify(found), /credential-canary|apiKey|token/);
    rmSync(join(dir, "models.json"));
    assert.equal(discoveredProfiles(source.load(), dir).available[0]!.rateSource, "Pi registry");
    usePiRegistry({ getModels: () => [] } as any);
    const unknown = discoveredProfiles(source.load(), dir);
    assert.equal(unknown.available.length, 0);
    assert.match(unknown.unavailable[0]!.reason, /update Pi/);
});
test("parallel failed SSO login does not report successful recovery", async (t) => {
    const dir = directory(t),
        script = join(dir, "fail.sh");
    writeFileSync(script, "#!/bin/sh\nsleep 0.2\necho secret-device-code\nexit 1\n", { mode: 0o700 });
    const recover = createRecovery(
        { ...config, ssoLoginCommand: [script] },
        { lock: join(dir, "login.lock"), timeoutMs: 5000, wsl: elsewhere },
    );
    const outcomes = await Promise.allSettled([recover(config.profile), recover(config.profile)]);
    assert.ok(outcomes.every((r) => r.status === "rejected"));
    assert.doesNotMatch(JSON.stringify(outcomes), /secret-device-code/);
});
