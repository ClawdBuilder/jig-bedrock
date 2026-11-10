// The Models route end of the provider: models registered against Bedrock's Anthropic endpoint, and the stream wrapper that
// hands Pi's Anthropic client the ARN for the wire and the signed fetch for auth. The Converse route stays reachable.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BedrockModel, Catalog } from "../src/catalog.ts";
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

test("Pi records this package's provider and short id while the ARN goes on the wire", async () => {
    await registry();
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    const anthropic = builtinProviders().find((provider: { id: string }) => provider.id === "anthropic");
    const dir = usageDir();
    try {
        const [model] = discoveredProfiles(catalog, dir).available;
        assert.ok(model);
        let body: Record<string, unknown> | undefined;
        const sse = [
            "event: message_start",
            'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}',
            "",
            "event: content_block_start",
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
            "",
            "event: content_block_stop",
            'data: {"type":"content_block_stop","index":0}',
            "",
            "event: message_delta",
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
            "",
            "event: message_stop",
            'data: {"type":"message_stop"}',
            "",
            "",
        ].join("\n");
        const signedFetch = (async (_url: string, init: RequestInit) => {
            body = JSON.parse(String(init.body)) as Record<string, unknown>;
            return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as typeof globalThis.fetch;
        const stream = bedrockStream(
            [model],
            { converse: () => assert.fail("no Converse call"), messages: anthropic.stream },
            () => catalog,
            () => "fixture-profile",
            signedFetch,
        );
        const events = [];
        for await (const event of stream(
            { ...model, provider: JIG_BEDROCK },
            { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
            { env: { AWS_PROFILE: "fixture-profile" } },
        )) {
            events.push(event);
        }
        const done = events.find((event) => event.type === "done") as { message: Record<string, unknown> };
        assert.equal(body?.model, ARN, "the request asks Bedrock for the ARN");
        assert.equal(done.message.provider, JIG_BEDROCK);
        assert.equal(done.message.model, model.id);
        assert.ok(
            ((done.message.usage as { cost?: { total?: number } }).cost?.total ?? 0) > 0,
            "cost comes from the recorded model",
        );
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
                messages: ((model: BedrockModel, _context: unknown, options: Record<string, unknown>) => {
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
        assert.equal(seen[0]?.model.id, messagesModel.id, "the recorded model is the short id");
        assert.equal(seen[0]?.model.provider, JIG_BEDROCK);
        assert.equal(seen[0]?.model.api, "anthropic-messages");
        assert.equal(seen[0]?.options.apiKey, "bedrock-sigv4");
        assert.equal(seen[0]?.options.fetch, signedFetch);
        assert.equal(seen[0]?.options.profile, "fixture-profile");

        // The payload hook: Pi's own hook runs first, then Sonnet 5.5's thinking-off shape. Opus is left as Pi sends it.
        const onPayload = seen[0]?.options.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;
        const rewritten = (await onPayload({ thinking: { type: "disabled" }, max_tokens: 10 }, {})) as {
            thinking: { type: string };
            model: string;
        };
        assert.deepEqual(rewritten.thinking, { type: "between_tools" });
        assert.equal(rewritten.model, ARN, "the wire model is the ARN");
        const hooked = bedrockStream(
            [messagesModel],
            {
                converse: () => assert.fail("no Converse call"),
                messages: ((_model: BedrockModel, _context: unknown, options: Record<string, unknown>) => {
                    seen.push({ model: { id: messagesModel.id, api: "anthropic-messages" }, options });
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

        const converseSeen: Array<{ id: string; api: string; apiKey: unknown; wireId?: string }> = [];
        const converse = bedrockStream(
            [converseModel],
            {
                converse: (async (model: BedrockModel, _context: unknown, options: Record<string, unknown>) => {
                    const onPayload = options.onPayload as (input: unknown, selected: unknown) => Promise<unknown>;
                    const command = (await onPayload({ modelId: model.id }, model)) as { modelId: string };
                    converseSeen.push({
                        id: model.id,
                        api: model.api,
                        apiKey: options.apiKey,
                        wireId: command.modelId,
                    });
                    return "converse" as unknown as never;
                }) as never,
            },
            () => catalog,
            () => "fixture-profile",
            signedFetch,
        );
        await (converse as unknown as (m: unknown, c: unknown, o: unknown) => unknown)(
            { ...converseModel, provider: JIG_BEDROCK },
            {},
            {},
        );
        assert.deepEqual(converseSeen, [
            { id: converseModel.id, api: "bedrock-converse-stream", apiKey: undefined, wireId: ARN },
        ]);
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

test("temperature follows Pi's Anthropic entry for each Claude family", async () => {
    await registry();
    const dir = usageDir();
    const table: Array<[string, boolean]> = [
        ["anthropic.claude-sonnet-5-5", false],
        ["anthropic.claude-haiku-5-5", false],
        ["anthropic.claude-opus-4-8", false],
        ["anthropic.claude-sonnet-4-6", true],
        ["anthropic.claude-sonnet-4-5-20250929-v1:0", true],
    ];
    try {
        for (const [foundation, temperature] of table) {
            const model = discoveredProfiles(
                {
                    ...catalog,
                    profiles: [{ arn: ARN, profile_name: "Fixture", foundation_model_id: foundation, region: REGION }],
                },
                dir,
            ).available[0];
            assert.ok(model, foundation);
            assert.equal(
                (model.compat as Record<string, unknown>).supportsTemperature,
                temperature,
                `${foundation} temperature`,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a Pi without the Anthropic registry path falls back to the name pattern", async () => {
    await usePiAnthropicRegistry(async () => {
        throw new Error("the path is not there");
    });
    const dir = usageDir();
    try {
        const [model] = discoveredProfiles(catalog, dir).available;
        assert.ok(model, "the provider still builds its model");
        const compat = (model.compat ?? {}) as Record<string, unknown>;
        assert.equal(compat.forceAdaptiveThinking, true, "the 5.5 fallback still marks adaptive thinking");
        assert.equal(compat.supportsMidConvoEffort, undefined, "no registry entry to copy");
        assert.equal(compat.supportsTemperature, true, "the base setting is untouched");
    } finally {
        await usePiAnthropicRegistry();
        rmSync(dir, { recursive: true, force: true });
    }
});
