// The request Pi's Anthropic client builds for a jig-bedrock model: the mid-conversation flags must produce the
// thinking-binding beta, `drop_block`, and a fixed tool-list prefix with the deferred placeholder.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Catalog, TeamBedrockModel } from "../src/catalog.ts";
import { discoveredProfiles, usePiAnthropicRegistry, usePiRegistry } from "../src/catalog.ts";
import { hostImport } from "./support/pi-host.ts";

const REGION = "us-east-1";
const ARN = `arn:aws:bedrock:${REGION}:123456789012:application-inference-profile/p0`;
const FOUNDATION = "anthropic.claude-sonnet-5-5";

async function registries(): Promise<void> {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    await usePiAnthropicRegistry();
    usePiRegistry(builtinProviders().find((provider: { id: string }) => provider.id === "amazon-bedrock"));
}

function catalog(foundation = FOUNDATION): Catalog {
    return {
        schema: 1,
        aws_profile: "fixture",
        account_id: "123456789012",
        regions: [REGION],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles: [{ arn: ARN, profile_name: "Fixture", foundation_model_id: foundation, region: REGION }],
    };
}

function tool(name: string) {
    return {
        name,
        description: `${name} tool`,
        parameters: { type: "object", properties: {}, additionalProperties: false },
    };
}

function transcript() {
    return {
        messages: [
            { role: "system", content: "You are helpful.", toolsAdded: [tool("bash")], timestamp: 0 },
            { role: "user", content: "think, then load a tool", timestamp: 1 },
            { role: "system", content: "", toolsAdded: [tool("read")], timestamp: 2 },
        ],
    };
}

async function requestBody(model: TeamBedrockModel, context: unknown): Promise<Record<string, any>> {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    const anthropic = builtinProviders().find((provider: { id: string }) => provider.id === "anthropic");
    const controller = new AbortController();
    return await new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the client did not build a request")), 5_000);
        anthropic.streamSimple(model, context, {
            apiKey: "test",
            reasoning: "high",
            signal: controller.signal,
            // Pi calls onPayload after building the request and before the SDK turns `betas` into a header.
            onPayload: (payload: Record<string, any>) => {
                clearTimeout(timer);
                resolve(structuredClone(payload));
                controller.abort();
                throw new Error("captured for the test");
            },
        });
    });
}

test("the Sonnet 5.5 request carries the thinking-binding beta, drop_block, and the deferred tools prefix", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-request-"));
    try {
        const [model] = discoveredProfiles(catalog(), dir).available;
        assert.ok(model);
        const body = await requestBody(model, transcript());
        assert.ok((body.betas ?? []).includes("thinking-binding-controls-2026-08-01"), JSON.stringify(body.betas));
        assert.equal(body.thinking?.type, "adaptive");
        assert.equal(body.thinking?.block_binding?.prefix_mismatch_behavior, "drop_block");
        assert.equal(body.output_config?.effort, "low");
        assert.deepEqual(
            (body.tools ?? []).map((entry: { name?: string }) => entry.name),
            ["bash", "__pi_deferred_placeholder__"],
            "the top-level list is the initial tool plus the stable placeholder",
        );
        assert.doesNotMatch(JSON.stringify(body.tools), /"read"/, "the later tool is not in the top-level list");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("without the mid-conversation flags nothing changes: no binding beta and the current tool list", async () => {
    await registries();
    const dir = mkdtempSync(path.join(tmpdir(), "jig-bedrock-request-"));
    try {
        const [base] = discoveredProfiles(catalog(), dir).available;
        assert.ok(base);
        const model: TeamBedrockModel = {
            ...base,
            compat: {
                supportsEagerToolInputStreaming: true,
                supportsCacheControlOnTools: true,
                supportsTemperature: true,
                forceAdaptiveThinking: true,
            },
        };
        const body = await requestBody(model, transcript());
        assert.ok(!(body.betas ?? []).includes("thinking-binding-controls-2026-08-01"));
        assert.equal(body.thinking?.block_binding, undefined);
        assert.deepEqual(
            (body.tools ?? []).map((entry: { name?: string }) => entry.name),
            ["bash", "read"],
            "without native tool changes the current tools are sent",
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
