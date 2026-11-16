import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type BedrockModel, registerBedrockProvider } from "../src/catalog.ts";
import { isRefusalError, isRefused, refusedModels, rememberRefusal } from "../src/refusals.ts";

const account = "123456789012";
const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123example";
const real = `AccessDeniedException: User: arn:aws:sts::${account}:assumed-role/ExampleRole/example-user is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: ${arn} because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action`;
const model: BedrockModel = {
    id: "claude-opus-5",
    api: "bedrock-converse-stream",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    arn,
    foundationModelId: "anthropic.claude-opus-5",
    rateSource: "test",
    cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
    aliases: [],
};
const catalog = {
    schema: 1,
    mode: "tag",
    aws_profile: "fixture",
    account_id: account,
    regions: ["us-east-1"],
    profiles: [
        {
            arn,
            profile_name: "team-opus",
            foundation_model_id: "anthropic.claude-opus-5",
            region: "us-east-1",
            kind: "application",
        },
    ],
} as never;

function nativeStream(message: string): any {
    return async function* () {
        yield { type: "error", error: { errorMessage: message } };
    };
}

async function registered(api: "bedrock-converse-stream" | "anthropic-messages", t: test.TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-refusal-request-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: dir };
    const models = [{ ...model, api }] as BedrockModel[];
    const providers: any[] = [];
    const pi = {
        registerProvider(provider: any) {
            providers.push(provider);
        },
    };
    const handler = (selected: BedrockModel, message: string) => {
        if (!isRefused(env, "fixture", account, selected.arn))
            rememberRefusal(env, "fixture", account, selected.arn, selected.id);
        return `AWS refused ${selected.id} for your AWS role (no permission to call this inference profile). It is hidden from /model.`;
    };
    await registerBedrockProvider(
        pi as never,
        dir,
        {
            stream: nativeStream(real),
            streamSimple: nativeStream(real),
        } as never,
        models,
        () => catalog,
        { profile: () => "fixture", auth: {} } as never,
        handler,
        { stream: nativeStream(real), streamSimple: nativeStream(real) } as never,
        (async () => undefined) as never,
        async () => {
            models.splice(0, models.length);
        },
    );
    const provider = providers.at(-1);
    return { env, models, provider, providerStream: provider.streamSimple };
}

for (const api of ["bedrock-converse-stream", "anthropic-messages"] as const) {
    test(`a ${api} 403 is explained, remembered and hidden after refresh`, async (t) => {
        const s = await registered(api, t);
        const events: any[] = [];
        for await (const event of s.providerStream(
            { ...s.models[0], provider: "jig-bedrock" },
            { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
            {},
        ))
            events.push(event);
        assert.match(events[0]?.error?.errorMessage ?? "", /AWS refused claude-opus-5/);
        assert.equal(isRefused(s.env, "fixture", account, arn), true);
        await s.provider.refreshModels({
            allowNetwork: true,
            force: true,
            signal: new AbortController().signal,
            publish: async (value: any) => {
                value.update();
                return true;
            },
        });
        assert.equal(s.provider.getModels().length, 0);
        assert.deepEqual(
            refusedModels(s.env, "fixture", account).map((entry) => entry.id),
            ["claude-opus-5"],
        );
    });
}

test("a profile id containing 500 is not mistaken for an HTTP status", async (t) => {
    const s = await registered("bedrock-converse-stream", t);
    const withDigits = real.replace("abc123example", "a-500-b");
    assert.equal(withDigits.includes("a-500-b"), true);
    assert.equal(isRefusalError(withDigits, withDigits.split("resource: ")[1]!.split(" because")[0]!), true);
});

test("the provider has one registration path with the refusal handler", async () => {
    const source = await import("node:fs").then((fs) =>
        fs.readFileSync(new URL("../src/provider.ts", import.meta.url), "utf8"),
    );
    assert.equal(
        (source.match(/registerBedrockProvider\(/g) ?? []).length,
        1,
        "every provider registration goes through register()",
    );
    assert.ok((source.match(/await register\(\)/g) ?? []).length >= 4);
});
