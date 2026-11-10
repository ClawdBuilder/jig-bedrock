// A real Bedrock bearer key in process.env must not reach this package's Converse request: Pi's Converse client reads
// the variable through getProviderEnvValue, where a scoped empty value falls back to process.env. The request goes to a
// local HTTP endpoint so the test sees the actual Authorization header; no AWS call is made.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BedrockModel, Catalog } from "../src/catalog.ts";
import { bedrockStream } from "../src/catalog.ts";
import { JIG_BEDROCK } from "../src/identity.ts";
import { hostImport } from "./support/pi-host.ts";

const ARN = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/orders-api";
const FOUNDATION = "anthropic.claude-haiku-5-5";

function catalog(): Catalog {
    return {
        schema: 1,
        mode: "explicit",
        aws_profile: "fixture",
        account_id: "123456789012",
        regions: ["us-east-1"],
        fetched_at: Math.floor(Date.now() / 1000),
        filter_hash: "key-variable",
        profiles: [
            {
                arn: ARN,
                profile_name: "Orders",
                foundation_model_id: FOUNDATION,
                region: "us-east-1",
                kind: "application",
            },
        ],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as Catalog;
}
function model(baseUrl: string): BedrockModel {
    return {
        id: "claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        api: "bedrock-converse-stream",
        baseUrl,
        provider: JIG_BEDROCK,
        arn: ARN,
        foundationModelId: FOUNDATION,
        rateSource: "Pi registry",
        aliases: [],
        reasoning: false,
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    };
}
function savedEnv(): () => void {
    const keys = ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_BEDROCK_FORCE_HTTP1"];
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    return () => {
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key] as string;
        }
    };
}

test("Converse signs with the profile and never sends the ambient Bedrock key", async (t) => {
    const restoreEnv = savedEnv();
    t.after(restoreEnv);
    process.env.AWS_BEARER_TOKEN_BEDROCK = "not-a-real-key";
    process.env.AWS_ACCESS_KEY_ID = "AKIAFIXTURE";
    process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret";
    process.env.AWS_BEDROCK_FORCE_HTTP1 = "1";
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((request, response) => {
        seen.push(request.headers as Record<string, string | string[] | undefined>);
        request.resume();
        response.writeHead(403, { "content-type": "application/json" });
        response.end('{"message":"No credentials"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    const native = builtinProviders().find((provider: { id: string }) => provider.id === "amazon-bedrock");
    assert.ok(native);
    const physical = model(baseUrl);
    const source = catalog();
    const stream = bedrockStream(
        [physical],
        { converse: native.stream },
        () => source,
        () => undefined,
    );
    const events = [];
    for await (const event of stream(
        physical,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        { env: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret" }, profile: undefined },
    )) {
        events.push(event);
    }
    assert.ok(seen.length > 0, "the request reached the local HTTP layer");
    const auth = seen.find((headers) => headers.authorization !== undefined)?.authorization;
    assert.equal(typeof auth, "string");
    assert.match(auth as string, /^AWS4-HMAC-SHA256 /);
    assert.doesNotMatch(JSON.stringify(seen), /Bearer|not-a-real-key/i);
    assert.equal(process.env.AWS_BEARER_TOKEN_BEDROCK, "not-a-real-key", "the ambient variable is restored");
    assert.equal(events.at(-1)?.type, "error");
});

test("the Messages signed fetch strips the bearer and sends SigV4", async () => {
    const { createSignedFetch } = await import("../src/bedrock-fetch.ts");
    const root = mkdtempSync(join(tmpdir(), "bedrock-key-messages-"));
    let headers: Record<string, string> | undefined;
    const signed = createSignedFetch({
        credentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "fixture-secret" }),
        fetch: (async (_input, init) => {
            headers = Object.fromEntries(new Headers(init?.headers).entries());
            return new Response('{"type":"error","error":{"type":"authentication_error","message":"stop"}}', {
                status: 403,
                headers: { "content-type": "application/json" },
            });
        }) as typeof globalThis.fetch,
    });
    assert.ok(headers === undefined);
    await signed("https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer not-a-real-key", "content-type": "application/json" },
        body: "{}",
    });
    assert.equal(headers?.authorization !== undefined, true);
    assert.match(headers?.authorization ?? "", /^AWS4-HMAC-SHA256 /);
    assert.doesNotMatch(JSON.stringify(headers), /Bearer|not-a-real-key/i);
    // `root` keeps the test's temp path distinct; no record or AWS call is involved here.
    assert.ok(root.length > 0);
});
