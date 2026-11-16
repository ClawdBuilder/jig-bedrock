import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Catalog } from "../src/catalog.ts";
import { createBedrockProvider } from "../src/provider.ts";

const catalog: Catalog = {
    schema: 1,
    mode: "system",
    aws_profile: "fixture",
    account_id: "123456789012",
    regions: ["us-east-1"],
    profiles: [
        {
            arn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5",
            profile_name: "Sonnet",
            foundation_model_id: "anthropic.claude-sonnet-5-5",
            region: "us-east-1",
            kind: "system",
        },
    ],
};

test("a saved default is restored from a registry that only knows registered models", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-restore-provider-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ defaultProvider: "jig-bedrock", defaultModel: "claude-sonnet-5-5" }),
    );
    let current: Catalog | undefined;
    const source = {
        load: () => current,
        refresh: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            current = catalog;
            return "ok" as const;
        },
        status: () => "ok" as const,
    };
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const pi = {
        on(name: string, hook: (event: any, ctx: any) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand() {},
        events: { emit() {} },
        setModel: async (selected: any) => {
            ctx.model = selected;
            return true;
        },
    };
    const ctx: any = {
        model: undefined,
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify() {}, setStatus() {}, setEditorText() {} },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: {
            find: (_provider: string, id: string) =>
                (providers.at(-1)?.getModels?.() ?? []).find((model: any) => model.id === id),
        },
    };
    await createBedrockProvider({
        env: { HOME: dir, PI_CODING_AGENT_DIR: dir },
        config: {
            team: "fixture",
            profile: "fixture",
            regions: ["us-east-1"],
            agentDir: dir,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: source,
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        backgroundRefresh: true,
    } as never)(pi as never);
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    for (let i = 0; i < 100 && ctx.model === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ctx.model?.id, "claude-sonnet-5-5");
    const input = hooks.get("input")?.[0]?.({ source: "interactive", text: "hi" }, ctx) as { action?: string };
    assert.equal(input.action, "continue");
});
