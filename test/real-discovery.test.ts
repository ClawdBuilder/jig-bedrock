/* biome-ignore-all lint/style/noNonNullAssertion: recorded shapes in assertions */
// The shapes in the 2026-11-10 real run: a global profile's foundation-model ARN has an empty region, and profile ids
// can carry a version suffix. One profile's bad answer is recorded for that profile, the others still load.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwsDiscovery, problemSummary, type Runner } from "../src/aws-discovery.ts";
import { bedrockStream, discoveredProfiles, resolveSelection, usePiRegistry } from "../src/catalog.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { JIG_BEDROCK } from "../src/identity.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { hostImport } from "./support/pi-host.ts";

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const arn = (id: string) => `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${id}`;
const config = {
    profile: "my-profile",
    regions: [REGION],
    ssoLoginCommand: ["aws", "sso", "login", "--profile", "{profile}"],
    signInAtStart: false,
};

function directory(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "real-discovery-"));
    return { dir, file: join(dir, "catalog.json") };
}

function shape(profileId: string, models: string[], type = "SYSTEM_DEFINED") {
    return JSON.stringify({
        inferenceProfileName: `Profile ${profileId}`,
        inferenceProfileArn: arn(profileId),
        inferenceProfileId: profileId,
        status: "ACTIVE",
        type,
        models: models.map((modelArn) => ({ modelArn })),
    });
}

function systemRow(id: string, name: string, foundation: string) {
    return {
        inferenceProfileArn: arn(id),
        inferenceProfileName: name,
        inferenceProfileId: id,
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
        models: [{ modelArn: `arn:aws:bedrock:${REGION}::foundation-model/${foundation}` }],
    };
}

function runner(
    overrides: { list?: string; profile?: Record<string, string>; malformed?: string[]; calls?: string[][] } = {},
): Runner {
    return async (_program, args) => {
        overrides.calls?.push(args);
        if (args.includes("get-caller-identity")) return JSON.stringify({ Account: ACCOUNT });
        if (args.includes("list-inference-profiles")) {
            if (overrides.list) throw new Error(overrides.list);
            const rows = [
                systemRow(
                    "global.anthropic.claude-haiku-5-5",
                    "Global Anthropic Claude Haiku 5.5",
                    "anthropic.claude-haiku-5-5",
                ),
                systemRow(
                    "us.anthropic.claude-haiku-5-5",
                    "US Anthropic Claude Haiku 5.5",
                    "anthropic.claude-haiku-5-5",
                ),
                systemRow(
                    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                    "US Anthropic Claude Sonnet 4.5",
                    "anthropic.claude-sonnet-4-5-20250929-v1:0",
                ),
                systemRow(
                    "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
                    "Global Anthropic Claude Sonnet 4.5",
                    "anthropic.claude-sonnet-4-5-20250929-v1:0",
                ),
            ].map((row) =>
                (overrides.malformed ?? []).includes(row.inferenceProfileId)
                    ? { ...row, models: [{ modelArn: "not-an-arn" }] }
                    : row,
            );
            return JSON.stringify({ inferenceProfileSummaries: rows });
        }
        const id = (args[args.indexOf("--inference-profile-identifier") + 1] ?? "").replace(arn(""), "");
        if (overrides.profile?.[id]) throw new Error(overrides.profile[id]);
        if (id === "global.anthropic.claude-haiku-5-5")
            return shape(id, [
                "arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-5-5",
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-5-5",
            ]);
        const foundationId = id.replace(/^(?:global|us|eu|apac|jp|au|ca|sa)\./, "");
        return shape(id, [`arn:aws:bedrock:${REGION}::foundation-model/${foundationId}`]);
    };
}

test("a global profile's foundation ARN with an empty region is accepted", async () => {
    const { dir, file } = directory();
    try {
        const source = createAwsDiscovery({ ...config, team: undefined, mode: "system" }, runner(), file);
        assert.equal(await source.refresh(true), "ok");
        const catalog = source.load();
        assert.equal(catalog?.profiles.length, 4);
        assert.equal(
            catalog?.profiles.find((p) => p.arn.includes("global."))?.foundation_model_id,
            "anthropic.claude-haiku-5-5",
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a version-suffixed profile id survives the cache, the model id, saved selection and the wire id", async () => {
    const { dir, file } = directory();
    try {
        const source = createAwsDiscovery({ ...config, team: undefined, mode: "system" }, runner(), file);
        assert.equal(await source.refresh(true), "ok");
        const saved = JSON.parse(readFileSync(file, "utf8")) as { profiles: Array<{ arn: string }> };
        const versionedArn = arn("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
        assert.ok(
            saved.profiles.some((p) => p.arn === versionedArn),
            "the cache keeps the colon",
        );

        const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
        usePiRegistry(builtinProviders().find((provider: { id: string }) => provider.id === "amazon-bedrock"));
        const models = discoveredProfiles(source.load(), dir).available;
        const versioned = models.find((model) => model.arn === versionedArn);
        assert.ok(versioned);
        const global = models.find((model) => model.arn === arn("global.anthropic.claude-sonnet-4-5-20250929-v1:0"));
        assert.ok(global);
        assert.equal(global.id, "claude-sonnet-4-5-global");
        assert.equal(resolveSelection(models, global.id)?.arn, global.arn);
        assert.equal(
            resolveSelection(models, "claude-sonnet-4-5--us-east-1--global.anthropic.claude-sonnet-4-5-20250929-v1:0")
                ?.arn,
            global.arn,
            "a saved old long id still resolves",
        );
        const selected = global;

        let recordedId: string | undefined;
        let wireId: string | undefined;
        const stream = bedrockStream(
            models,
            {
                converse: async (
                    wire: { id: string },
                    _context: unknown,
                    options: { onPayload?: (...args: unknown[]) => unknown },
                ) => {
                    recordedId = wire.id;
                    const command = (await options.onPayload?.({ modelId: wire.id }, wire)) as { modelId: string };
                    wireId = command.modelId;
                    throw new Error("captured");
                },
            } as never,
            source.load,
            () => "my-profile",
        );
        await assert.rejects(
            async () => stream({ ...selected, provider: JIG_BEDROCK } as never, {} as never, {} as never),
            /captured/,
        );
        assert.equal(recordedId, selected.id, "the recorded model is the short id");
        assert.equal(wireId, selected.arn, "the request model is the ARN, colon included");
        assert.doesNotMatch(selected.baseUrl, /inference-profile/, "the URL still has no profile id");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("one profile's unreadable answer is recorded and the others load; the failure names the step", async () => {
    const { dir, file } = directory();
    try {
        const source = createAwsDiscovery(
            { ...config, team: undefined, mode: "system" },
            runner({ malformed: ["us.anthropic.claude-haiku-5-5"] }),
            file,
        );
        assert.equal(await source.refresh(true), "ok");
        const catalog = source.load();
        assert.equal(catalog?.profiles.length, 3);
        assert.equal(catalog?.errors?.[0]?.message, "its model address has an unexpected form");
        assert.match(catalog?.errors?.[0]?.profile ?? "", /us\.anthropic/);

        const all = createAwsDiscovery(
            { ...config, team: undefined, mode: "system" },
            runner({
                malformed: [
                    "global.anthropic.claude-haiku-5-5",
                    "us.anthropic.claude-haiku-5-5",
                    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                    "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
                ],
            }),
            file,
        );
        assert.equal(await all.refresh(true), "unavailable");
        assert.match(all.failure?.() ?? "", /Could not read .*its model address has an unexpected form/);
        assert.doesNotMatch(all.failure?.() ?? "", /\b\d{12}\b/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a failed listing names the step and the plain reason", async () => {
    const { dir, file } = directory();
    try {
        const source = createAwsDiscovery(
            { ...config, team: undefined, mode: "system" },
            runner({ list: "Could not connect" }),
            file,
        );
        assert.equal(await source.refresh(true), "network");
        assert.match(source.failure?.() ?? "", /Could not list inference profiles: AWS could not be reached/);
        assert.doesNotMatch(source.failure?.() ?? "", /\b\d{12}\b|network/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the result summary names at most three short ids, then points at /bedrock models", () => {
    const summary =
        problemSummary([
            { profile: arn("orders-api-1"), message: "its model address has an unexpected form" },
            { profile: arn("orders-api-2"), message: "AWS denied access" },
            { profile: arn("orders-api-3"), message: "AWS timed out" },
            { profile: arn("orders-api-4"), message: "AWS returned an unexpected answer" },
            { profile: arn("orders-api-5"), message: "AWS returned an unexpected answer" },
        ]) ?? "";
    assert.match(summary, /orders-api-1: its model address has an unexpected form/);
    assert.match(summary, /orders-api-3: AWS timed out/);
    assert.doesNotMatch(summary, /orders-api-4/);
    assert.match(summary, /and 2 more: \/bedrock models lists them/);
    assert.doesNotMatch(summary, /\b123456789012\b/);
});

test("tag profile reads run four at a time", async () => {
    const { dir, file } = directory();
    try {
        const ids = Array.from({ length: 8 }, (_, i) => `orders-api-${i + 1}`);
        const appArn = (id: string) => `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/${id}`;
        let inFlight = 0;
        let peak = 0;
        const calls: string[][] = [];
        const slow: Runner = async (_program, args) => {
            calls.push(args);
            if (args.includes("get-caller-identity")) return JSON.stringify({ Account: ACCOUNT });
            if (args.includes("get-resources"))
                return JSON.stringify({
                    ResourceTagMappingList: ids.map((id) => ({
                        ResourceARN: appArn(id),
                        Tags: [
                            { Key: "Team", Value: "my-team" },
                            { Key: "Active", Value: "true" },
                        ],
                    })),
                });
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight--;
            const id = (args[args.indexOf("--inference-profile-identifier") + 1] ?? "").split("/").pop() ?? "";
            return JSON.stringify({
                inferenceProfileName: id,
                inferenceProfileArn: appArn(id),
                status: "ACTIVE",
                type: "APPLICATION",
                models: [{ modelArn: `arn:aws:bedrock:${REGION}::foundation-model/anthropic.claude-sonnet-5-5` }],
            });
        };
        const source = createAwsDiscovery(
            { ...config, team: "my-team", tagKey: "Team", tagValue: "my-team" },
            slow,
            file,
        );
        assert.equal(await source.refresh(true), "ok");
        assert.equal(source.load()?.profiles.length, 8);
        assert.ok(peak > 1, `reads were sequential (peak ${peak})`);
        assert.ok(peak <= 4, `more than four reads overlapped (peak ${peak})`);
        assert.equal(calls.filter((args) => args.includes("get-inference-profile")).length, 8);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("system discovery uses one identity and one listing call per region", async () => {
    const { dir, file } = directory();
    try {
        const ids = Array.from({ length: 33 }, (_, i) => `us.anthropic.claude-sonnet-5-5-${i + 1}`);
        const row = (region: string, id: string) => ({
            inferenceProfileArn: `arn:aws:bedrock:${region}:${ACCOUNT}:inference-profile/${id}`,
            inferenceProfileName: id,
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [{ modelArn: `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-5-5` }],
        });
        const calls: string[][] = [];
        const listing: Runner = async (_program, args) => {
            calls.push(args);
            if (args.includes("get-caller-identity")) return JSON.stringify({ Account: ACCOUNT });
            const region = args[args.indexOf("--region") + 1] ?? REGION;
            return JSON.stringify({ inferenceProfileSummaries: ids.map((id) => row(region, id)) });
        };
        const one = createAwsDiscovery({ ...config, team: undefined, mode: "system" }, listing, file);
        assert.equal(await one.refresh(true), "ok");
        assert.equal(one.load()?.profiles.length, 33);
        assert.equal(calls.length, 2, calls.map((args) => args.slice(0, 2).join(" ")).join("; "));
        assert.equal(calls.filter((args) => args.includes("get-inference-profile")).length, 0);

        const twoFile = join(dir, "catalog-two.json");
        const before = calls.length;
        const two = createAwsDiscovery(
            { ...config, team: undefined, mode: "system", regions: [REGION, "us-west-2"] },
            listing,
            twoFile,
        );
        assert.equal(await two.refresh(true), "ok");
        assert.equal(two.load()?.profiles.length, 66);
        assert.equal(calls.length - before, 3, "one account check and one listing per region");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an oversized listing fails the refresh with the 1 MiB reason", async () => {
    const { dir, file } = directory();
    try {
        const runner: Runner = async (_program, args) => {
            if (args.includes("get-caller-identity")) return JSON.stringify({ Account: ACCOUNT });
            return "x".repeat(1_048_577);
        };
        const source = createAwsDiscovery({ ...config, team: undefined, mode: "system" }, runner, file);
        assert.equal(await source.refresh(true), "unavailable");
        assert.match(source.failure?.() ?? "", /1 MiB limit/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

function providerHarness() {
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const notices: Array<{ text: string; type?: string }> = [];
    const providers: Array<{ getModels?: () => Array<{ id: string }> }> = [];
    const pi = {
        on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), fn]);
        },
        registerProvider(provider: { getModels?: () => Array<{ id: string }> }) {
            providers.push(provider);
        },
        registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            commands.set(name, options);
        },
        events: { emit() {} },
        setModel: () => false,
    };
    const ctx = {
        mode: "rpc",
        hasUI: true,
        model: undefined,
        sessionManager: { getBranch: () => [], getSessionId: () => "test" },
        modelRegistry: { find: () => undefined },
        ui: { notify: (text: string, type?: string) => notices.push({ text, type }), setStatus: () => {} },
    };
    return { hooks, commands, notices, providers, pi, ctx };
}

test("a cached catalog for an automatically picked AWS_PROFILE is in the provider at the factory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-discovery-env-profile-"));
    try {
        const cache = {
            schema: 1 as const,
            mode: "system" as const,
            aws_profile: "dev",
            account_id: ACCOUNT,
            regions: [REGION],
            fetched_at: Math.floor(Date.now() / 1000),
            profiles: [
                {
                    arn: arn("global.anthropic.claude-sonnet-5-5"),
                    profile_name: "global Sonnet",
                    foundation_model_id: "anthropic.claude-sonnet-5-5",
                    region: REGION,
                    kind: "system" as const,
                },
            ],
        };
        const h = providerHarness();
        await createBedrockProvider({
            env: { HOME: dir, PI_CODING_AGENT_DIR: dir, AWS_PROFILE: "dev" },
            config: { ...config, profile: undefined, agentDir: dir } as ResolvedConfig,
            listProfiles: async () => ["dev"],
            catalog: { load: () => cache, refresh: async () => "ok" },
            backgroundRefresh: false,
            usageEvents: false,
        })(h.pi as never);
        const provider = h.providers.find((entry) => entry.getModels !== undefined);
        assert.ok(
            provider?.getModels?.().some((model) => model.id === "claude-sonnet-5-5"),
            JSON.stringify(provider),
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a cached catalog for the ambient credential chain is in the provider at the factory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-discovery-ambient-"));
    try {
        const cache = {
            schema: 1 as const,
            mode: "system" as const,
            aws_profile: "",
            account_id: ACCOUNT,
            regions: [REGION],
            fetched_at: Math.floor(Date.now() / 1000),
            profiles: [
                {
                    arn: arn("global.anthropic.claude-haiku-5-5"),
                    profile_name: "global Haiku",
                    foundation_model_id: "anthropic.claude-haiku-5-5",
                    region: REGION,
                    kind: "system" as const,
                },
            ],
        };
        const h = providerHarness();
        await createBedrockProvider({
            env: {
                HOME: dir,
                PI_CODING_AGENT_DIR: dir,
                AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
                AWS_SECRET_ACCESS_KEY: "fixture",
            },
            config: { ...config, profile: undefined, agentDir: dir } as ResolvedConfig,
            listProfiles: async () => undefined,
            catalog: { load: () => cache, refresh: async () => "ok" },
            backgroundRefresh: false,
            usageEvents: false,
        })(h.pi as never);
        const provider = h.providers.find((entry) => entry.getModels !== undefined);
        assert.ok(provider?.getModels?.().some((model) => model.id === "claude-haiku-5-5"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a failed refresh shows the discovery reason once, without the raw status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-discovery-provider-"));
    try {
        const h = providerHarness();
        await createBedrockProvider({
            env: { HOME: dir, PI_CODING_AGENT_DIR: dir },
            config: { ...config, team: undefined } as ResolvedConfig,
            listProfiles: async () => ["my-profile"],
            catalog: {
                load: () => undefined,
                refresh: async () => "network",
                failure: () => "Could not list inference profiles: AWS could not be reached.",
            },
            backgroundRefresh: false,
            usageEvents: false,
        })(h.pi as never);
        for (const hook of h.hooks.get("session_start") ?? []) await hook({ reason: "startup" }, h.ctx);
        const command = h.commands.get("bedrock");
        assert.ok(command);
        await command.handler("refresh", h.ctx);
        const text = h.notices.map((notice) => notice.text).join("\n");
        assert.match(text, /Reading the models from AWS/);
        assert.match(text, /Could not list inference profiles: AWS could not be reached/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
