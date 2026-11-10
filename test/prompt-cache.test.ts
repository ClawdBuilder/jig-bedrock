import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promptCacheFor } from "../src/prompt-cache.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { hostFile, hostImport } from "./support/pi-host.ts";

test("Claude 4.5 and later declare 5-minute and 1-hour lifetimes; older Claude and Nova only 5 minutes", () => {
    for (const id of [
        "anthropic.claude-opus-5",
        "anthropic.claude-opus-5-5",
        "anthropic.claude-sonnet-5-5",
        "anthropic.claude-sonnet-4-6",
        "anthropic.claude-opus-4-8",
        "anthropic.claude-haiku-4-5-20251001-v1:0",
        "us.anthropic.claude-opus-4-8",
        "global.anthropic.claude-sonnet-5",
    ])
        assert.deepEqual(promptCacheFor(id), { short: 300, long: 3600 }, id);
    for (const id of [
        "anthropic.claude-3-7-sonnet-20250219-v1:0",
        "anthropic.claude-opus-4-1-20250805-v1:0",
        "anthropic.claude-sonnet-4-20250514-v1:0",
    ])
        assert.deepEqual(promptCacheFor(id), { short: 300 }, id);
    for (const id of ["amazon.nova-2-lite-v1:0", "amazon.nova-pro-v1:0", "us.amazon.nova-micro-v1:0"])
        assert.deepEqual(promptCacheFor(id), { short: 300 }, id);
});
test("models Bedrock does not list for caching stay undeclared, so Pi never warms them", () => {
    for (const id of ["openai.gpt-6-luna", "amazon.nova-premier-v1:0", "meta.llama4", "fixture.model", ""])
        assert.equal(promptCacheFor(id), undefined, id);
});
test("a real Pi session sees the declared lifetimes, which is what turns on its cache warming", async (t) => {
    const sdk = await hostImport("@earendil-works/pi-coding-agent");
    const { getPromptCacheTtlMs } = await import(pathToFileURL(hostFile("dist/core/cache-warmer.js")).href);
    const dir = mkdtempSync(join(tmpdir(), "bedrock-session-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const region = "us-east-1",
        arn = (n: number) => `arn:aws:bedrock:${region}:123456789012:application-inference-profile/p${n}`;
    const cache: any = {
        schema: 1,
        team: "fixture",
        aws_profile: "fixture",
        account_id: "123456789012",
        regions: [region],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles: ["anthropic.claude-sonnet-5-5", "amazon.nova-pro-v1:0"].map((id, n) => ({
            arn: arn(n),
            profile_name: `Fixture ${n}`,
            foundation_model_id: id,
            region,
        })),
    };
    const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
    });
    const settingsManager = sdk.SettingsManager.inMemory({});
    const factory = createBedrockProvider({
        config: {
            team: "fixture",
            profile: "fixture",
            regions: [region],
            agentDir: dir,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: { load: () => cache, refresh: async () => "ok" },
        ssoRecover: async () => {},
        budget: { load: () => undefined, refresh: async () => {} },
        backgroundRefresh: false,
        usageEvents: false,
    });
    const loader = new sdk.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [factory],
    });
    await loader.reload();
    const { session } = await sdk.createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime,
        resourceLoader: loader,
        sessionManager: sdk.SessionManager.inMemory(dir),
        settingsManager,
    });
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "print" });
    const sonnet = modelRuntime.getModels("jig-bedrock").find((m: any) => m.id === "claude-sonnet-5-5"),
        nova = modelRuntime.getModels("jig-bedrock").find((m: any) => m.id === "nova-pro");
    assert.equal(getPromptCacheTtlMs(sonnet, {}), 300_000);
    assert.equal(getPromptCacheTtlMs(sonnet, { env: { PI_CACHE_RETENTION: "long" } }), 3_600_000);
    assert.equal(getPromptCacheTtlMs(nova, {}), 300_000);
    assert.equal(
        getPromptCacheTtlMs(nova, { env: { PI_CACHE_RETENTION: "long" } }),
        undefined,
        "Nova has no 1-hour tier",
    );
});
