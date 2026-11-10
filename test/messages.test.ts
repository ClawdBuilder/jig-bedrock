// The Models route end of the provider: models registered against Bedrock's Anthropic endpoint, and the stream wrapper that
// hands Pi's Anthropic client the ARN for the wire and the signed fetch for auth. The Converse route stays reachable.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Catalog, TeamBedrockModel } from "../src/catalog.ts";
import { bedrockStream, discoveredProfiles, usePiAnthropicRegistry, usePiRegistry } from "../src/catalog.ts";
import { JIG_BEDROCK } from "../src/identity.ts";
import { hostImport } from "./support/pi-host.ts";

const REGION = "us-east-1";
const ARN = `arn:aws:bedrock:${REGION}:123456789012:application-inference-profile/p0`;
const FOUNDATION = "anthropic.claude-sonnet-5-5";

async function registry(): Promise<void> {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    await usePiAnthropicRegistry();
    usePiRegistry(builtinProviders().find((provider: { id: string }) => provider.id === "amazon-bedrock"));
}

const catalog: Catalog = {
    schema: 1,
    team: "fixture",
    aws_profile: "fixture",
    account_id: "123456789012",
    regions: [REGION],
    fetched_at: Math.floor(Date.now() / 1000),
    profiles: [{ arn: ARN, profile_name: "Fixture", foundation_model_id: FOUNDATION, region: REGION }],
};

function usageDir(): string {
    return mkdtempSync(path.join(tmpdir(), "jig-bedrock-usage-"));
}

test("models use Pi's anthropic-messages API on Bedrock's /anthropic route, and Converse stays a setting away", async () => {
    await registry();
    const dir = usageDir();
    try {
        const [messages] = discoveredProfiles(catalog, dir).available;
        assert.ok(messages);
        assert.equal(messages.api, "anthropic-messages");
        assert.equal(messages.baseUrl, `https://bedrock-runtime.${REGION}.amazonaws.com/anthropic`);
        assert.equal(messages.id, "claude-sonnet-5-5", "the picker id stays the slug");
        assert.equal(messages.arn, ARN, "the ARN is the wire model");
        const compat = (messages.compat ?? {}) as Record<string, unknown>;
        assert.deepEqual(
            {
                midConvo: compat.supportsMidConvoSystemMessages,
                tools: compat.supportsMidConvoToolChanges,
                effort: compat.supportsMidConvoEffort,
                longCache: compat.supportsLongCacheRetention,
                strict: compat.supportsStrictTools,
                sessions: compat.sendSessionAffinityHeaders,
                adaptive: compat.forceAdaptiveThinking,
            },
            {
                midConvo: true,
                tools: true,
                effort: true,
                longCache: false,
                strict: false,
                sessions: false,
                adaptive: true,
            },
        );

        const [converse] = discoveredProfiles(catalog, dir, "converse").available;
        assert.ok(converse);
        assert.equal(converse.api, "bedrock-converse-stream");
        assert.equal(converse.baseUrl, `https://bedrock-runtime.${REGION}.amazonaws.com`);
        assert.equal(converse.compat, undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a profile that is not Claude keeps the Converse route even when Messages is the default", async () => {
    await registry();
    const dir = usageDir();
    const mixed: Catalog = {
        ...catalog,
        profiles: [
            { arn: ARN, profile_name: "Claude", foundation_model_id: FOUNDATION, region: REGION },
            {
                arn: `arn:aws:bedrock:${REGION}:123456789012:application-inference-profile/nova`,
                profile_name: "Nova",
                foundation_model_id: "amazon.nova-pro-v1:0",
                region: REGION,
            },
            {
                arn: `arn:aws:bedrock:${REGION}:123456789012:application-inference-profile/gpt`,
                profile_name: "GPT",
                foundation_model_id: "global.openai.gpt-6-astra",
                region: REGION,
            },
        ],
    };
    try {
        const models = discoveredProfiles(mixed, dir).available;
        const route = (foundation: string) => models.find((m) => m.foundationModelId === foundation);
        assert.equal(route(FOUNDATION)?.api, "anthropic-messages");
        for (const foundation of ["amazon.nova-pro-v1:0", "global.openai.gpt-6-astra"]) {
            const model = route(foundation);
            assert.ok(model, `${foundation} is in the catalog`);
            assert.equal(model.api, "bedrock-converse-stream", `${foundation} is not on the Anthropic route`);
            assert.equal(model.compat, undefined, `${foundation} keeps its own route's compat`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Opus 5.5 has no off level; Sonnet 5.5 keeps one", async () => {
    await registry();
    const dir = usageDir();
    const two: Catalog = {
        ...catalog,
        profiles: [
            { arn: ARN, profile_name: "Sonnet", foundation_model_id: FOUNDATION, region: REGION },
            {
                arn: `arn:aws:bedrock:${REGION}:123456789012:application-inference-profile/opus`,
                profile_name: "Opus",
                foundation_model_id: "anthropic.claude-opus-5-5",
                region: REGION,
            },
        ],
    };
    try {
        const models = discoveredProfiles(two, dir).available;
        const sonnet = models.find((m) => m.foundationModelId === FOUNDATION);
        const opus = models.find((m) => m.foundationModelId === "anthropic.claude-opus-5-5");
        assert.ok(sonnet && opus);
        assert.equal((opus.thinkingLevelMap as Record<string, unknown> | undefined)?.off, null);
        assert.notEqual((sonnet.thinkingLevelMap as Record<string, unknown> | undefined)?.off, null);

        // What Pi does with that map: off leaves the offered levels, and a saved off clamps to the lowest available.
        const { getSupportedThinkingLevels, clampThinkingLevel } = (await hostImport("@earendil-works/pi-ai")) as {
            getSupportedThinkingLevels: (model: unknown) => string[];
            clampThinkingLevel: (model: unknown, level: string) => string;
        };
        const wire = { ...opus, provider: JIG_BEDROCK };
        const levels = getSupportedThinkingLevels(wire);
        assert.equal(levels.includes("off"), false, "off is not offered");
        assert.equal(levels[0], "minimal");
        assert.equal(clampThinkingLevel(wire, "off"), "minimal", "a saved off lands on the lowest level");
        assert.equal(getSupportedThinkingLevels({ ...sonnet, provider: JIG_BEDROCK }).includes("off"), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the Messages wrapper sends the ARN, the signed fetch and a throwaway key; the Converse wrapper does not", async () => {
    await registry();
    const dir = usageDir();
    try {
        const [messagesModel] = discoveredProfiles(catalog, dir).available;
        const [converseModel] = discoveredProfiles(catalog, dir, "converse").available;
        assert.ok(messagesModel && converseModel);

        const seen: Array<{ model: { id: string; api: string }; options: Record<string, unknown> }> = [];
        const signedFetch = (async () => new Response("{}")) as typeof globalThis.fetch;
        const messages = bedrockStream(
            [messagesModel],
            {
                converse: () => assert.fail("the Converse stream must not be used for a Messages model"),
                messages: ((model: TeamBedrockModel, _context: unknown, options: Record<string, unknown>) => {
                    seen.push({ model, options });
                    return "messages" as unknown as never;
                }) as never,
            },
            () => catalog,
            () => "fixture-profile",
            signedFetch,
        );
        const result = (messages as unknown as (m: unknown, c: unknown, o: unknown) => unknown)(
            { ...messagesModel, provider: JIG_BEDROCK },
            {},
            {},
        );
        assert.equal(result, "messages");
        assert.equal(seen[0]?.model.id, ARN, "the wire model is the ARN");
        assert.equal(seen[0]?.model.api, "anthropic-messages");
        assert.equal(seen[0]?.options.apiKey, "bedrock-sigv4");
        assert.equal(seen[0]?.options.fetch, signedFetch);
        assert.equal(seen[0]?.options.profile, "fixture-profile");

        // The payload hook: Pi's own hook runs first, then Sonnet 5.5's thinking-off shape. Opus is left as Pi sends it.
        const onPayload = seen[0]?.options.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;
        const rewritten = (await onPayload({ thinking: { type: "disabled" }, max_tokens: 10 }, {})) as {
            thinking: { type: string };
        };
        assert.deepEqual(rewritten.thinking, { type: "between_tools" });
        const hooked = bedrockStream(
            [messagesModel],
            {
                converse: () => assert.fail("no Converse call"),
                messages: ((_model: TeamBedrockModel, _context: unknown, options: Record<string, unknown>) => {
                    seen.push({ model: { id: ARN, api: "anthropic-messages" }, options });
                    return "messages" as unknown as never;
                }) as never,
            },
            () => catalog,
            () => "fixture-profile",
            signedFetch,
        );
        (hooked as unknown as (m: unknown, c: unknown, o: unknown) => unknown)(
            { ...messagesModel, provider: JIG_BEDROCK },
            {},
            { onPayload: (payload: Record<string, unknown>) => ({ ...payload, fromPi: true }) },
        );
        const second = seen[1];
        assert.ok(second, "the second call was made");
        const chained = (await (second.options.onPayload as (p: unknown, m: unknown) => Promise<unknown>)(
            { thinking: { type: "disabled" } },
            {},
        )) as { thinking: { type: string }; fromPi?: boolean };
        assert.equal(chained.fromPi, true, "Pi's payload hook still runs");
        assert.deepEqual(chained.thinking, { type: "between_tools" });

        const converseSeen: Array<{ id: string; api: string; apiKey: unknown }> = [];
        const converse = bedrockStream(
            [converseModel],
            {
                converse: ((model: TeamBedrockModel, _context: unknown, options: Record<string, unknown>) => {
                    converseSeen.push({ id: model.id, api: model.api, apiKey: options.apiKey });
                    return "converse" as unknown as never;
                }) as never,
            },
            () => catalog,
            () => "fixture-profile",
            signedFetch,
        );
        (converse as unknown as (m: unknown, c: unknown, o: unknown) => unknown)(
            { ...converseModel, provider: JIG_BEDROCK },
            {},
            {},
        );
        assert.deepEqual(converseSeen, [{ id: ARN, api: "bedrock-converse-stream", apiKey: undefined }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an older Claude keeps the old compat: no mid-conversation effort is copied", async () => {
    await registry();
    const dir = usageDir();
    const old: Catalog = {
        ...catalog,
        profiles: [
            {
                arn: ARN,
                profile_name: "Sonnet 4.5",
                foundation_model_id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
                region: REGION,
            },
        ],
    };
    try {
        const [model] = discoveredProfiles(old, dir).available;
        assert.ok(model);
        const compat = (model.compat ?? {}) as Record<string, unknown>;
        assert.equal(compat.supportsMidConvoEffort, undefined, "no effort flag on an older model");
        assert.equal(compat.supportsMidConvoSystemMessages, true, "the existing Bedrock-tested base is unchanged");
        assert.equal(compat.supportsMidConvoToolChanges, true);
        assert.equal(compat.forceAdaptiveThinking, undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Opus 4.8 takes adaptive thinking from Pi's registry, like Pi's own Converse route", async () => {
    await registry();
    const dir = usageDir();
    const adaptive: Catalog = {
        ...catalog,
        profiles: [
            {
                arn: ARN,
                profile_name: "Opus 4.8",
                foundation_model_id: "anthropic.claude-opus-4-8",
                region: REGION,
            },
        ],
    };
    try {
        const [model] = discoveredProfiles(adaptive, dir).available;
        assert.ok(model);
        const compat = (model.compat ?? {}) as Record<string, unknown>;
        assert.equal(compat.forceAdaptiveThinking, true);
        assert.equal(compat.supportsMidConvoEffort, undefined, "Opus 4.8 has no mid-conversation effort in Pi's entry");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
