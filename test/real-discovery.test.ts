// The shapes in the 2026-11-10 real run: a global profile's foundation-model ARN has an empty region, and profile ids
// can carry a version suffix. One profile's bad answer is recorded for that profile, the others still load.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwsDiscovery, problemSummary, type Runner } from "../src/aws-discovery.ts";
import type { Catalog as BedrockCatalog } from "../src/catalog.ts";
import { bedrockStream, discoveredProfiles, resolveSelection, usePiRegistry } from "../src/catalog.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { JIG_BEDROCK } from "../src/identity.ts";
import { createJigBedrock } from "../src/provider.ts";
import { hostImport } from "./support/pi-host.ts";

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const arn = (id: string) => `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${id}`;
const config = {
    profile: "my-profile",
    regions: [REGION],
    usageDir: "/missing-usage",
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

function runner(overrides: { list?: string; profile?: Record<string, string>; calls?: string[][] } = {}): Runner {
    return async (_program, args) => {
        overrides.calls?.push(args);
        if (args.includes("get-caller-identity")) return JSON.stringify({ Account: ACCOUNT });
        if (args.includes("list-inference-profiles")) {
            if (overrides.list) throw new Error(overrides.list);
            return JSON.stringify({
                inferenceProfileSummaries: [
                    {
                        inferenceProfileArn: arn("global.anthropic.claude-haiku-5-5"),
                        inferenceProfileName: "Global Anthropic Claude Haiku 5.5",
                    },
                    {
                        inferenceProfileArn: arn("us.anthropic.claude-haiku-5-5"),
                        inferenceProfileName: "US Anthropic Claude Haiku 5.5",
                    },
                    {
                        inferenceProfileArn: arn("us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
                        inferenceProfileName: "US Anthropic Claude Sonnet 4.5",
                    },
                    {
                        inferenceProfileArn: arn("global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
                        inferenceProfileName: "Global Anthropic Claude Sonnet 4.5",
                    },
                ],
            });
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
        const withColon = models.find((model) => /-v1:0$/.test(model.id));
        assert.ok(versioned);
        assert.ok(withColon, JSON.stringify(models.map((model) => model.id)));
        assert.equal(withColon.arn, arn("global.anthropic.claude-sonnet-4-5-20250929-v1:0"));
        const selected = withColon;
        assert.equal(resolveSelection(models, selected.id)?.arn, selected.arn);

        let wireId: string | undefined;
        const stream = bedrockStream(
            models,
            {
                converse: (wire: { id: string }) => {
                    wireId = wire.id;
                    throw new Error("captured");
                },
            } as never,
            source.load,
            () => "my-profile",
        );
        assert.throws(() => stream({ ...selected, provider: JIG_BEDROCK } as never, {} as never), /captured/);
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
            runner({ profile: { "us.anthropic.claude-haiku-5-5": "model ARN" } }),
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
                profile: {
                    "global.anthropic.claude-haiku-5-5": "model ARN",
                    "us.anthropic.claude-haiku-5-5": "model ARN",
                    "us.anthropic.claude-sonnet-4-5-20250929-v1:0": "model ARN",
                    "global.anthropic.claude-sonnet-4-5-20250929-v1:0": "model ARN",
                },
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

test("the result summary names at most three short ids, then points at /bedrock-profiles", () => {
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
    assert.match(summary, /and 2 more: \/bedrock-profiles lists them/);
    assert.doesNotMatch(summary, /\b123456789012\b/);
});

test("profile reads run four at a time", async () => {
    const { dir, file } = directory();
    try {
        const ids = Array.from({ length: 8 }, (_, i) => `us.anthropic.claude-sonnet-5-5-${i + 1}`);
        let inFlight = 0;
        let peak = 0;
        const calls: string[][] = [];
        const slow: Runner = async (_program, args) => {
            calls.push(args);
            if (args.includes("get-caller-identity")) return JSON.stringify({ Account: ACCOUNT });
            if (args.includes("list-inference-profiles"))
                return JSON.stringify({
                    inferenceProfileSummaries: ids.map((id) => ({
                        inferenceProfileArn: arn(id),
                        inferenceProfileName: id,
                    })),
                });
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight--;
            const id = (args[args.indexOf("--inference-profile-identifier") + 1] ?? "").replace(arn(""), "");
            return shape(
                id,
                [`arn:aws:bedrock:${REGION}::foundation-model/anthropic.claude-sonnet-5-5`],
                "APPLICATION",
            );
        };
        const source = createAwsDiscovery({ ...config, team: undefined, mode: "system" }, slow, file);
        assert.equal(await source.refresh(true), "ok");
        assert.equal(source.load()?.profiles.length, 8);
        assert.ok(peak > 1, `reads were sequential (peak ${peak})`);
        assert.ok(peak <= 4, `more than four reads overlapped (peak ${peak})`);
        assert.equal(calls.filter((args) => args.includes("get-inference-profile")).length, 8);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

function providerHarness() {
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const notices: Array<{ text: string; type?: string }> = [];
    const pi = {
        on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), fn]);
        },
        registerProvider() {},
        registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            commands.set(name, options);
        },
        events: { emit() {} },
        setModel: () => false,
    };
    const ctx = {
        mode: "rpc",
        model: undefined,
        sessionManager: { getBranch: () => [], getSessionId: () => "test" },
        modelRegistry: { find: () => undefined },
        ui: { notify: (text: string, type?: string) => notices.push({ text, type }), setStatus: () => {} },
    };
    return { hooks, commands, notices, pi, ctx };
}

test("a failed refresh shows the discovery reason once, without the raw status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-discovery-provider-"));
    try {
        const h = providerHarness();
        await createJigBedrock({
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
        const command = h.commands.get("bedrock-refresh");
        assert.ok(command);
        await command.handler("", h.ctx);
        const warnings = h.notices.filter((notice) => notice.type === "warning");
        assert.equal(warnings.length, 1, JSON.stringify(h.notices));
        assert.match(warnings[0]?.text ?? "", /Could not list inference profiles: AWS could not be reached/);
        assert.doesNotMatch(
            warnings[0]?.text ?? "",
            /refresh (?:network|unavailable)|discovery (?:network|unavailable)/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a partial catalog reports one summary naming at most three profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-discovery-summary-"));
    try {
        const h = providerHarness();
        const errors = Array.from({ length: 5 }, (_, i) => ({
            profile: arn(`orders-api-${i + 1}`),
            message: "its model address has an unexpected form",
        }));
        const catalog: BedrockCatalog = {
            schema: 1,
            mode: "system",
            aws_profile: "my-profile",
            account_id: ACCOUNT,
            regions: [REGION],
            fetched_at: Math.floor(Date.now() / 1000),
            filter_hash: "x",
            profiles: [],
            errors,
        };
        await createJigBedrock({
            env: { HOME: dir, PI_CODING_AGENT_DIR: dir },
            config: { ...config, team: undefined } as ResolvedConfig,
            listProfiles: async () => ["my-profile"],
            catalog: { load: () => catalog, refresh: async () => "ok" },
            backgroundRefresh: false,
            usageEvents: false,
        })(h.pi as never);
        for (const hook of h.hooks.get("session_start") ?? []) await hook({ reason: "startup" }, h.ctx);
        const command = h.commands.get("bedrock-refresh");
        assert.ok(command);
        await command.handler("", h.ctx);
        const warnings = h.notices.filter((notice) => notice.type === "warning");
        assert.equal(warnings.length, 1, JSON.stringify(h.notices));
        assert.match(warnings[0]?.text ?? "", /orders-api-1/);
        assert.match(warnings[0]?.text ?? "", /and 2 more: \/bedrock-profiles lists them/);
        assert.doesNotMatch(warnings[0]?.text ?? "", /orders-api-4/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
