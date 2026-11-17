/* biome-ignore-all lint/suspicious/noExplicitAny: provider and Pi doubles */
/* biome-ignore-all lint/style/noNonNullAssertion: test assertions */
// The first /login with no model selected leaves the first registered Bedrock model selected for the session.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { fakeAwsHttp } from "./support/fake-aws-http.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";

async function login(t: test.TestContext, options: { model?: { provider: string; id: string } } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-first-model-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify({ profile: "fixture", regions: [REGION] }));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(dir, "cache") };
    const fake = fakeAwsHttp({
        profiles: [
            {
                arn: `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-sonnet-5-5`,
                name: "System Sonnet",
                region: REGION,
                foundation: "anthropic.claude-sonnet-5-5",
                tags: {},
                kind: "system",
            },
        ],
    });
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const notices: string[] = [];
    const selections: any[] = [];
    const ctx: any = {
        hasUI: true,
        mode: "tui",
        signal: new AbortController().signal,
        model: options.model,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "test", getBranch: () => [] },
        modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    };
    const pi = {
        on(name: string, hook: (event: any, ctx: any) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand() {},
        events: { emit() {} },
        setModel: async (model: any) => {
            selections.push(model);
            ctx.model = model;
            return true;
        },
    };
    await createBedrockProvider({
        env,
        catalog: undefined,
        listProfiles: async () => ["fixture"],
        loginListProfiles: async () => ["fixture"],
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" }),
        verifyProfile: async () => ({ ok: true }),
        check: async () =>
            ({
                node: { status: "ready", version: "22.19.0" },
                aws: { status: "ready", version: "2.34.46" },
                platform: "linux",
            }) as never,
        backgroundRefresh: false,
    } as never)(pi as never);
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    const provider = providers.find((entry) => entry?.id === "jig-bedrock");
    assert.ok(provider, "the Bedrock provider is registered");
    await provider.auth.apiKey.login({
        signal: new AbortController().signal,
        prompt: async (prompt: any) => {
            if (prompt.type !== "select") return "";
            if (prompt.message?.includes("How do you sign in to AWS?")) return "existing";
            if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
            return "profile:fixture";
        },
        notify: (event: any) => notices.push(event.message ?? ""),
    });
    // The selection is announced after Pi's own no-default line, with the other post-login notices.
    await new Promise((resolve) => setTimeout(resolve, 350));
    return { notices, selections, ctx, models: provider.getModels?.().map((model: any) => model.id) ?? [] };
}

test("the first /login selects the first registered model only when none is selected", async (t) => {
    const first = await login(t);
    assert.deepEqual(
        first.selections.map((model) => ({ provider: model.provider, id: model.id })),
        [{ provider: "jig-bedrock", id: "claude-sonnet-5-5" }],
        JSON.stringify({ selections: first.selections, models: first.models, notices: first.notices }),
    );
    assert.match(
        first.notices.join("\n"),
        /Selected claude-sonnet-5-5 for this session\. To keep it for every start: \/model, select it, Ctrl\+S\./,
    );

    const kept = await login(t, { model: { provider: "anthropic", id: "claude-sonnet-5-5" } });
    assert.deepEqual(kept.selections, [], JSON.stringify(kept.selections));
    assert.doesNotMatch(kept.notices.join("\n"), /Selected .* for this session/);
});
