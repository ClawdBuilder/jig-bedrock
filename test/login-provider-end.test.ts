import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Catalog } from "../src/catalog.ts";
import { jigBedrock } from "../src/index.ts";

function catalog(region: string): Catalog {
    return {
        schema: 1,
        mode: "system",
        aws_profile: "keys",
        account_id: "123456789012",
        regions: [region],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles: [
            {
                arn: `arn:aws:bedrock:${region}:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5`,
                profile_name: "Sonnet",
                foundation_model_id: "anthropic.claude-sonnet-5-5",
                region,
                kind: "system",
            },
        ],
    };
}

async function harness(t: test.TestContext, raw: Record<string, unknown>, discoveryWorks = true) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-login-end-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, AWS_CONFIG_FILE: join(dir, "config") };
    writeFileSync(env.AWS_CONFIG_FILE, "[profile keys]\nregion = us-east-1\n");
    if (discoveryWorks) writeFileSync(join(agent, "bedrock.json"), JSON.stringify(raw));
    else mkdirSync(join(agent, "bedrock.json"));
    const source = {
        load: () => catalog("us-east-1"),
        refresh: async () => {
            const region = (raw.regions as string[] | undefined)?.[0] ?? "us-east-1";
            source.load = () => catalog(region);
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
        setModel: async () => true,
    };
    await jigBedrock({
        env,
        config: raw,
        catalog: source as never,
        listProfiles: async () => ["keys", "demo-sso"],
        ssoRecover: async () => {},
        verifyProfile: async () => ({ ok: true }),
        check: async () => ({
            node: { status: "ready", version: "22.19.0" },
            aws: { status: "ready", version: "2.34.0" },
            platform: "linux",
        }),
        backgroundRefresh: false,
    } as never)(pi as never);
    const notices: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: { find: () => undefined },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    return { dir, agent, env, providers, notices, ctx };
}

const answers = (prompt: any): string => {
    if (prompt.type === "select" && prompt.message?.includes("How do you sign in to AWS?")) return "existing";
    if (prompt.message === "Which AWS profile should Bedrock use?") return "profile:keys";
    if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
    if (prompt.message === "AWS regions for discovery (comma separated)") return "eu-west-1";
    return "";
};

test("a failed discovery save reaches ctx.ui.notify after login returns", async (t) => {
    const s = await harness(t, {}, false);
    const provider = s.providers.find((entry) => entry?.id === "jig-bedrock");
    await provider.auth.apiKey.login({
        signal: new AbortController().signal,
        prompt: async (prompt: any) => answers(prompt),
        notify: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(
        s.notices.some((notice) => notice.includes("Bedrock settings were not saved")),
        JSON.stringify(s.notices),
    );
});

test("login under an active preset saves into it and the session uses it", async (t) => {
    const s = await harness(t, {
        preset: "work",
        profile: "old",
        regions: ["us-east-1"],
        presets: { work: { profile: "old", regions: ["us-east-1"] } },
    });
    const provider = s.providers.find((entry) => entry?.id === "jig-bedrock");
    await provider.auth.apiKey.login({
        signal: new AbortController().signal,
        prompt: async (prompt: any) => answers(prompt),
        notify: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const saved = JSON.parse(readFileSync(join(s.agent, "bedrock.json"), "utf8"));
    assert.equal(saved.presets.work.profile, "keys");
    assert.deepEqual(saved.presets.work.regions, ["eu-west-1"]);
    assert.equal(saved.profile, "old");
    assert.deepEqual(saved.regions, ["us-east-1"]);
    assert.ok(
        s.notices.some((notice) => notice.includes("Saved to preset work.")),
        JSON.stringify(s.notices),
    );
    assert.doesNotMatch(s.notices.join("\n"), /preset add/);
    const models = s.providers.at(-1)?.getModels?.() ?? [];
    assert.ok(
        models.some((model: any) => String(model.baseUrl).includes("eu-west-1")),
        JSON.stringify(models),
    );
});
