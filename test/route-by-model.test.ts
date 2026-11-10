// Which route a model uses: Messages where Pi's own Anthropic entry lists mid-conversation tool changes and the real run
// agreed, Converse everywhere else, for AWS-defined and application profiles alike; and what the Messages route sends.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSignedFetch } from "../src/bedrock-fetch.ts";
import type { BedrockModel, Catalog, Profile } from "../src/catalog.ts";
import { bedrockStream, discoveredProfiles, routeOf, usePiAnthropicRegistry, usePiRegistry } from "../src/catalog.ts";
import { JIG_BEDROCK } from "../src/identity.ts";
import { signRequest } from "../src/sigv4.ts";
import { hostImport } from "./support/pi-host.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const application = (name: string) => `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/${name}`;
const system = (id: string) => `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${id}`;

async function registries(): Promise<void> {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    await usePiAnthropicRegistry();
    usePiRegistry(builtinProviders().find((provider: { id: string }) => provider.id === "amazon-bedrock"));
}

function catalogOf(...profiles: Profile[]): Catalog {
    return {
        schema: 1,
        aws_profile: "my-profile",
        account_id: ACCOUNT,
        regions: [REGION],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles,
    };
}
const profileOf = (foundation: string, arn: string, kind: "application" | "system" = "application"): Profile => ({
    arn,
    profile_name: "Orders API",
    foundation_model_id: foundation,
    region: REGION,
    kind,
});

/** The result of the real runs of 2026-11-10 on AWS: the models whose Messages route kept the cache after a tool load. */
const WORKS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-4-8"];
/** Answered 400 or 404 on Messages in the same runs (or, for opus-5, 400 on the first request). */
const FAILS = [
    "claude-sonnet-5",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "claude-opus-5",
];

test("every model of the real runs lands on the route that worked for it, from Pi's own entry", async () => {
    await registries();
    for (const id of WORKS) {
        const found = routeOf({ foundation_model_id: `anthropic.${id}` }, {});
        assert.deepEqual(found, { route: "messages", reason: "Pi lists tool changes" }, id);
    }
    for (const id of FAILS.filter((m) => m !== "claude-opus-5")) {
        assert.equal(routeOf({ foundation_model_id: `anthropic.${id}` }, {}).route, "converse", id);
    }
    assert.deepEqual(routeOf({ foundation_model_id: "anthropic.claude-sonnet-5" }, {}), {
        route: "converse",
        reason: "not on the Messages route",
    });
    assert.deepEqual(routeOf({ foundation_model_id: "anthropic.claude-opus-5" }, {}), {
        route: "converse",
        reason: "known exception",
    });
});

test("Pi's entry decides for every Claude model it lists, so a new Pi moves a model without a change here", async () => {
    await registries();
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    const anthropic = builtinProviders().find((provider: { id: string }) => provider.id === "anthropic");
    for (const entry of anthropic.getModels() as Array<{ id: string; compat?: Record<string, unknown> }>) {
        const expected =
            entry.compat?.supportsMidConvoToolChanges === true && entry.id !== "claude-opus-5"
                ? "messages"
                : "converse";
        assert.equal(routeOf({ foundation_model_id: `anthropic.${entry.id}` }, {}).route, expected, entry.id);
    }
});

test("version suffixes, dates and region prefixes name the same model", async () => {
    await registries();
    for (const id of [
        "anthropic.claude-sonnet-4-5-20250929-v1:0",
        "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "anthropic.claude-opus-4-6-v1",
    ])
        assert.equal(routeOf({ foundation_model_id: id }, {}).route, "converse", id);
    assert.equal(routeOf({ foundation_model_id: "global.anthropic.claude-haiku-5-5" }, {}).route, "messages");
    assert.equal(routeOf({ foundationModelId: "anthropic.claude-haiku-5-5" }, {}).route, "messages");
});

test("a model Pi does not know, and a model that is not Claude, use Converse and say why", async () => {
    await registries();
    assert.deepEqual(routeOf({ foundation_model_id: "anthropic.claude-sonnet-9" }, {}), {
        route: "converse",
        reason: "Pi has no Messages entry",
    });
    assert.deepEqual(routeOf({ foundation_model_id: "amazon.nova-pro-v1:0" }, {}), {
        route: "converse",
        reason: "not a Claude model",
    });
    await usePiAnthropicRegistry(async () => {
        throw new Error("the path is not there");
    });
    try {
        assert.deepEqual(routeOf({ foundation_model_id: "anthropic.claude-sonnet-5-5" }, {}), {
            route: "converse",
            reason: "Pi has no Messages entry",
        });
    } finally {
        await usePiAnthropicRegistry();
    }
});

test("the settings: api converse and converseModels keep models on Converse, messagesModels forces Messages", async () => {
    await registries();
    const sonnet = { foundation_model_id: "anthropic.claude-sonnet-5-5" };
    assert.deepEqual(routeOf(sonnet, { api: "converse" }), { route: "converse", reason: "your setting" });
    assert.deepEqual(routeOf(sonnet, { converseModels: ["claude-sonnet-5-5"] }), {
        route: "converse",
        reason: "your setting",
    });
    assert.equal(routeOf(sonnet, { converseModels: ["claude-opus-5-5"] }).route, "messages", "another model's entry");
    // For a model newer than this Pi knows, and for the known exception once a person has seen it work.
    for (const id of ["claude-sonnet-9", "claude-opus-5", "claude-sonnet-5"]) {
        assert.deepEqual(routeOf({ foundation_model_id: `anthropic.${id}` }, { messagesModels: [id] }), {
            route: "messages",
            reason: "your setting",
        });
    }
    assert.equal(
        routeOf({ foundation_model_id: "global.anthropic.claude-sonnet-9" }, { messagesModels: ["claude-sonnet-9"] })
            .route,
        "messages",
    );
    assert.equal(
        routeOf(sonnet, { api: "converse", messagesModels: ["claude-sonnet-5-5"] }).route,
        "converse",
        "api converse turns the Messages route off for every model",
    );
    assert.equal(
        routeOf({ foundation_model_id: "amazon.nova-pro-v1:0" }, { messagesModels: ["nova-pro"] }).route,
        "converse",
        "a model that is not Claude has no Messages route",
    );
});

test("one rule for both kinds of profile: AWS-defined and application profiles of a model share a route", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-route-"));
    try {
        const models = discoveredProfiles(
            catalogOf(
                profileOf("anthropic.claude-haiku-5-5", system("global.anthropic.claude-haiku-5-5"), "system"),
                profileOf("anthropic.claude-haiku-5-5", application("orders-api")),
                profileOf("anthropic.claude-sonnet-5", system("us.anthropic.claude-sonnet-5"), "system"),
                profileOf("anthropic.claude-sonnet-5", application("orders-api-s5")),
                profileOf("anthropic.claude-opus-5", application("orders-api-o5")),
                profileOf("anthropic.claude-sonnet-4-5-20250929-v1:0", application("orders-api-s45")),
            ),
            dir,
        ).available;
        const apiOf = (arn: string) => models.find((m) => m.arn === arn)?.api;
        assert.equal(apiOf(system("global.anthropic.claude-haiku-5-5")), "anthropic-messages");
        assert.equal(apiOf(application("orders-api")), "anthropic-messages");
        assert.equal(apiOf(system("us.anthropic.claude-sonnet-5")), "bedrock-converse-stream");
        assert.equal(apiOf(application("orders-api-s5")), "bedrock-converse-stream");
        assert.equal(apiOf(application("orders-api-o5")), "bedrock-converse-stream");
        assert.equal(apiOf(application("orders-api-s45")), "bedrock-converse-stream");
        for (const model of models.filter((m) => m.api === "bedrock-converse-stream"))
            assert.equal(model.compat, undefined, `${model.id} keeps Converse without Anthropic compat`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the settings reach the model list: converseModels and messagesModels move a model's route and base URL", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-route-"));
    try {
        const catalog = catalogOf(
            profileOf("anthropic.claude-sonnet-5-5", application("orders-api")),
            profileOf("anthropic.claude-opus-4-1-20250805-v1:0", application("orders-api-old")),
        );
        const byDefault = discoveredProfiles(catalog, dir, { api: "messages" }).available;
        assert.deepEqual(
            byDefault.map((m) => m.api),
            ["anthropic-messages", "bedrock-converse-stream"],
        );
        const moved = discoveredProfiles(catalog, dir, {
            api: "messages",
            converseModels: ["claude-sonnet-5-5"],
            messagesModels: ["claude-opus-4-1"],
        }).available;
        assert.deepEqual(
            moved.map((m) => [m.api, m.baseUrl]),
            [
                ["bedrock-converse-stream", `https://bedrock-runtime.${REGION}.amazonaws.com`],
                ["anthropic-messages", `https://bedrock-runtime.${REGION}.amazonaws.com/anthropic`],
            ],
        );
        // The plain route name still works.
        assert.equal(discoveredProfiles(catalog, dir, "converse").available[0]?.api, "bedrock-converse-stream");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("compat claims no more than Pi's entry: tool changes only where Pi says so, never for a forced model Pi lacks", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-route-"));
    try {
        const catalog = catalogOf(
            profileOf("anthropic.claude-sonnet-5-5", application("orders-api")),
            profileOf("anthropic.claude-opus-4-1-20250805-v1:0", application("orders-api-old")),
            profileOf("anthropic.claude-sonnet-5", application("orders-api-s5")),
        );
        const models = discoveredProfiles(catalog, dir, {
            messagesModels: ["claude-opus-4-1", "claude-sonnet-5"],
        }).available;
        const compat = (arn: string) => (models.find((m) => m.arn === arn)?.compat ?? {}) as Record<string, unknown>;
        const known = compat(application("orders-api"));
        assert.equal(known.supportsMidConvoSystemMessages, true);
        assert.equal(known.supportsMidConvoToolChanges, true);
        for (const arn of [application("orders-api-old"), application("orders-api-s5")]) {
            assert.equal(models.find((m) => m.arn === arn)?.api, "anthropic-messages", arn);
            assert.equal(compat(arn).supportsMidConvoSystemMessages, undefined, `${arn} claims no mid-conversation`);
            assert.equal(compat(arn).supportsMidConvoToolChanges, undefined, `${arn} claims no tool changes`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---- a session that changes route in the middle (the update from 0.2.x, or a changed setting) ----

const tool = (name: string) => ({
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
});

/** A recorded session: thinking, a tool_search that loaded orders_api_7, the loaded tool called, and a new question. */
function session(recordedApi: string, model: string) {
    const usage = {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const reply = (content: unknown[], timestamp: number, stopReason = "toolUse") => ({
        role: "assistant",
        content,
        api: recordedApi,
        provider: JIG_BEDROCK,
        model,
        usage,
        stopReason,
        timestamp,
    });
    return {
        messages: [
            { role: "system", content: "You are helpful.", toolsAdded: [tool("bash")], timestamp: 0 },
            { role: "user", content: "How many sheep are left? Then look up order 42.", timestamp: 1 },
            reply(
                [
                    {
                        type: "thinking",
                        thinking: "17 minus 8 is 9.",
                        thinkingSignature: "signature-from-the-old-route",
                    },
                    { type: "text", text: "Nine. Loading the order tool." },
                    { type: "toolCall", id: "toolu_01", name: "tool_search", arguments: { query: "orders_api_7" } },
                ],
                2,
            ),
            {
                role: "toolResult",
                toolCallId: "toolu_01",
                toolName: "tool_search",
                content: [{ type: "text", text: "loaded orders_api_7" }],
                isError: false,
                timestamp: 3,
            },
            { role: "system", content: "", toolsAdded: [tool("orders_api_7")], timestamp: 4 },
            reply(
                [
                    { type: "thinking", thinking: "Now the order.", thinkingSignature: "second-signature" },
                    { type: "toolCall", id: "toolu_02", name: "orders_api_7", arguments: { orderId: "42" } },
                ],
                5,
            ),
            {
                role: "toolResult",
                toolCallId: "toolu_02",
                toolName: "orders_api_7",
                content: [{ type: "text", text: "Order 42: shipped." }],
                isError: false,
                timestamp: 6,
            },
            reply([{ type: "text", text: "Nine sheep; order 42 shipped." }], 7, "stop"),
            { role: "user", content: "And order 43?", timestamp: 8 },
        ],
    };
}

/** The request the package's own stream builds for `model`, captured before it would leave the machine. */
async function captured(model: BedrockModel, catalog: Catalog, context: unknown, reasoning = "high") {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    const providers = builtinProviders() as Array<{ id: string; streamSimple: never }>;
    const stream = bedrockStream(
        [model],
        {
            converse: providers.find((p) => p.id === "amazon-bedrock")?.streamSimple as never,
            messages: providers.find((p) => p.id === "anthropic")?.streamSimple as never,
        },
        () => catalog,
        () => "my-profile",
        (async () => new Response("{}")) as typeof globalThis.fetch,
    );
    const controller = new AbortController();
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no request was built")), 5_000);
        const events = (stream as unknown as (m: unknown, c: unknown, o: unknown) => AsyncIterable<unknown>)(
            { ...model, provider: JIG_BEDROCK },
            context,
            {
                reasoning,
                signal: controller.signal,
                onPayload: (payload: Record<string, unknown>) => {
                    clearTimeout(timer);
                    resolve(structuredClone(payload));
                    controller.abort();
                    throw new Error("captured for the test");
                },
            },
        );
        void (async () => {
            try {
                for await (const _event of events);
            } catch {
                /* the capture hook aborts the request on purpose */
            }
        })();
    });
}

test("a session recorded on Messages carries on over Converse with its thinking blocks, and the reverse", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-route-"));
    try {
        const catalog = catalogOf(profileOf("anthropic.claude-sonnet-5-5", application("orders-api")));
        const [onMessages] = discoveredProfiles(catalog, dir).available;
        const [onConverse] = discoveredProfiles(catalog, dir, { converseModels: ["claude-sonnet-5-5"] }).available;
        assert.ok(onMessages && onConverse);
        assert.equal(onMessages.id, onConverse.id, "the saved model id is the same on both routes");
        assert.equal(onMessages.api, "anthropic-messages");
        assert.equal(onConverse.api, "bedrock-converse-stream");

        // Messages, then Converse (the setting changed, or the update moved the model).
        const toConverse = await captured(onConverse, catalog, session("anthropic-messages", onConverse.id));
        const converseText = JSON.stringify(toConverse);
        assert.doesNotMatch(converseText, /signature-from-the-old-route|second-signature/, "no foreign signature");
        assert.doesNotMatch(converseText, /reasoningContent/, "the old thinking blocks are not replayed");
        assert.match(converseText, /Nine\. Loading the order tool\./, "the text of the old replies stays");
        assert.match(converseText, /orders_api_7/, "the tool call and the loaded tool stay");
        assert.match(converseText, /And order 43\?/);

        // Converse, then Messages.
        const toMessages = await captured(onMessages, catalog, session("bedrock-converse-stream", onMessages.id));
        const messagesText = JSON.stringify(toMessages);
        assert.doesNotMatch(messagesText, /signature-from-the-old-route|second-signature/);
        assert.doesNotMatch(messagesText, /"type":"thinking"/, "the old thinking blocks are not replayed");
        assert.match(messagesText, /Nine\. Loading the order tool\./);
        assert.match(messagesText, /orders_api_7/);
        assert.match(messagesText, /And order 43\?/);
        // The continued turn is a normal one on the new route: thinking is asked for afresh.
        assert.equal((toMessages.thinking as { type?: string } | undefined)?.type, "adaptive");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a session on the same route keeps its thinking blocks (the control for the test above)", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-route-"));
    try {
        const catalog = catalogOf(profileOf("anthropic.claude-sonnet-5-5", application("orders-api")));
        const [onMessages] = discoveredProfiles(catalog, dir).available;
        assert.ok(onMessages);
        const body = await captured(onMessages, catalog, session("anthropic-messages", onMessages.id));
        assert.match(JSON.stringify(body), /signature-from-the-old-route/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---- the 1-hour cache ----

test("the Messages route does not ask for the 1-hour cache and says no model there has it", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-route-"));
    try {
        const catalog = catalogOf(profileOf("anthropic.claude-sonnet-5-5", application("orders-api")));
        const [onMessages] = discoveredProfiles(catalog, dir).available;
        const [onConverse] = discoveredProfiles(catalog, dir, "converse").available;
        assert.ok(onMessages && onConverse);
        assert.deepEqual(onMessages.promptCache, { short: 300 }, "no 1-hour lifetime to price or warm on Messages");
        assert.deepEqual(onConverse.promptCache, { short: 300, long: 3600 }, "Converse keeps the 1-hour lifetime");
        assert.equal((onMessages.compat as Record<string, unknown>).supportsLongCacheRetention, false);

        const body = await captured(
            onMessages,
            catalog,
            { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
            "off",
        );
        // A person who sets PI_CACHE_RETENTION=long gets the same request as everyone: 5-minute checkpoints, no ttl.
        const text = JSON.stringify(body);
        assert.match(text, /"cache_control":\{"type":"ephemeral"\}/);
        assert.doesNotMatch(text, /"ttl"/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("PI_CACHE_RETENTION=long sends no ttl on Messages, and the same asked of Converse still reaches Pi", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-route-"));
    const before = process.env.PI_CACHE_RETENTION;
    process.env.PI_CACHE_RETENTION = "long";
    try {
        const catalog = catalogOf(profileOf("anthropic.claude-sonnet-5-5", application("orders-api")));
        const [onMessages] = discoveredProfiles(catalog, dir).available;
        assert.ok(onMessages);
        const body = await captured(onMessages, catalog, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
        assert.doesNotMatch(JSON.stringify(body), /"ttl"/);
        assert.match(JSON.stringify(body), /"cache_control":\{"type":"ephemeral"\}/);
    } finally {
        if (before === undefined) delete process.env.PI_CACHE_RETENTION;
        else process.env.PI_CACHE_RETENTION = before;
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---- ids with a version suffix, and global profiles, on the Messages route ----

const SSE = [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1}}}',
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

for (const [label, foundation, id, settings] of [
    ["a global profile", "anthropic.claude-haiku-5-5", "global.anthropic.claude-haiku-5-5", {}],
    ["a regional profile", "anthropic.claude-haiku-5-5", "us.anthropic.claude-haiku-5-5", {}],
    [
        "a version-suffixed id forced onto Messages",
        "anthropic.claude-haiku-4-5-20251001-v1:0",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        { messagesModels: ["claude-haiku-4-5"] },
    ],
    [
        "a global version-suffixed id forced onto Messages",
        "anthropic.claude-haiku-4-5-20251001-v1:0",
        "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        { messagesModels: ["claude-haiku-4-5"] },
    ],
] as const) {
    test(`${label} (${id}): the URL, the body and the signature on the Messages route`, async () => {
        await registries();
        const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-route-"));
        try {
            const catalog = catalogOf(profileOf(foundation, system(id), "system"));
            const [model] = discoveredProfiles(catalog, dir, settings).available;
            assert.ok(model);
            assert.equal(model.api, "anthropic-messages");
            const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" };
            const now = new Date("2026-11-10T12:00:00.000Z");
            const seen: Array<{ url: string; headers: Headers; body: string }> = [];
            const signedFetch = createSignedFetch({
                credentials: async () => credentials,
                now: () => now,
                fetch: (async (url: string, init: RequestInit) => {
                    seen.push({ url, headers: new Headers(init.headers), body: String(init.body) });
                    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
                }) as typeof globalThis.fetch,
            });
            const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
            const anthropic = builtinProviders().find((provider: { id: string }) => provider.id === "anthropic");
            const stream = bedrockStream(
                [model],
                { converse: () => assert.fail("no Converse call"), messages: anthropic.streamSimple },
                () => catalog,
                () => "my-profile",
                signedFetch,
            );
            const events = [];
            for await (const event of stream(
                { ...model, provider: JIG_BEDROCK },
                { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
                { env: { AWS_PROFILE: "my-profile" } },
            ))
                events.push(event);
            assert.ok(
                events.some((event) => event.type === "done"),
                JSON.stringify(events.at(-1)),
            );

            const [request] = seen;
            assert.ok(request && seen.length === 1);
            // Pi's Anthropic client asks for the beta endpoint; the query is part of what is signed.
            assert.equal(
                request.url,
                `https://bedrock-runtime.${REGION}.amazonaws.com/anthropic/v1/messages?beta=true`,
            );
            const body = JSON.parse(request.body) as { model: string };
            assert.equal(body.model, system(id), "the wire model is the whole profile ARN, colon and all");
            assert.equal(request.headers.get("x-api-key"), null);
            assert.equal(request.headers.get("x-amz-date"), "20261110T120000Z");
            assert.equal(request.headers.get("x-amz-security-token"), "token");
            const authorization = request.headers.get("authorization") ?? "";
            assert.match(
                authorization,
                /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261110\/us-east-1\/bedrock\/aws4_request,/,
            );
            const signedHeaders = /SignedHeaders=([^,]+),/.exec(authorization)?.[1]?.split(";") ?? [];
            for (const name of ["host", "x-amz-date", "x-amz-security-token", "content-type"])
                assert.ok(signedHeaders.includes(name), `${name} is signed`);
            assert.ok(!signedHeaders.includes("x-api-key") && !signedHeaders.includes("authorization"));
            // The signature covers the exact body that was sent.
            const given: Record<string, string> = {};
            request.headers.forEach((value, name) => {
                given[name] = value;
            });
            const again = signRequest({
                method: "POST",
                url: request.url,
                headers: given,
                body: request.body,
                region: REGION,
                credentials,
                now,
            });
            assert.equal(again.authorization, authorization);
            const tampered = signRequest({
                method: "POST",
                url: request.url,
                headers: given,
                body: request.body.replace("hi", "ho"),
                region: REGION,
                credentials,
                now,
            });
            assert.notEqual(tampered.authorization, authorization);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}
