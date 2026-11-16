/* biome-ignore-all lint/suspicious/noExplicitAny: fixtures stand in for Pi objects */
// What a settings save tells the session: a save that starts no refresh leaves no "settings changed" mark behind, and a
// save that does reload the models says so once, not twice.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { hostImport } from "./support/pi-host.ts";

const account = "123456789012";
type Hook = (...args: any[]) => unknown;

async function start(t: test.TestContext) {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    const foundation = builtinProviders()
        .find((provider: { id: string }) => provider.id === "amazon-bedrock")
        .getModels()[0];
    const profile = (number: number) => ({
        arn: `arn:aws:bedrock:us-east-1:${account}:application-inference-profile/p${number}`,
        profile_name: `Fixture ${number}`,
        foundation_model_id: foundation.id,
        region: "us-east-1",
    });
    const cache: any = {
        schema: 1,
        aws_profile: "fixture",
        account_id: account,
        regions: ["us-east-1"],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles: [profile(1), profile(2)],
    };
    const dir = mkdtempSync(join(tmpdir(), "bedrock-settings-message-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify({ profile: "fixture", regions: ["us-east-1"] }));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, LANG: "C.UTF-8" };
    const hooks = new Map<string, Hook[]>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
        on(name: string, hook: Hook) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider() {},
        registerCommand(name: string, value: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async () => true,
    };
    const controller = (await createBedrockProvider({
        env,
        config: {
            team: "fixture",
            profile: "fixture",
            regions: ["us-east-1"],
            agentDir: agent,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: { load: () => cache, refresh: async () => "ok", status: () => "ok" },
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        ssoCheck: async () => "ok",
        budget: { load: () => undefined, refresh: async () => {} },
        verifyProfile: async () => ({ ok: true }),
        backgroundRefresh: false,
        usageEvents: false,
    } as never)(pi as never)) as {
        models: Array<{ id: string }>;
        refresh: () => Promise<string>;
    };
    const notices: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getBranch: () => [], getSessionId: () => "s" },
        modelRegistry: { find: () => undefined },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    const command = commands.get("bedrock");
    assert.ok(command, "the /bedrock command is registered");
    return { cache, command, controller, ctx, notices, profile };
}

test("a save that reloads nothing does not mark the next refresh as a settings change", async (t) => {
    const s = await start(t);
    assert.equal(s.controller.models.length, 2, "the saved list is registered");
    await s.command.handler("set monthlyBudgetUsd 50", s.ctx);
    assert.match(s.notices.join("\n"), /monthlyBudgetUsd: 50/, s.notices.join("\n"));
    s.cache.profiles.push(s.profile(3));
    await s.controller.refresh();
    const text = s.notices.join("\n");
    assert.match(text, /1 new model in \/model/, text);
    assert.doesNotMatch(text, /models in \/model \(\d+ left\)/, text);
});

test("a save that reloads the models shows one progress line", async (t) => {
    const s = await start(t);
    await s.command.handler("set regions us-east-1,us-west-2", s.ctx);
    const text = s.notices.join("\n");
    const progress = text.match(/Loading models for the new settings|Reading the models from AWS/g) ?? [];
    assert.equal(progress.length, 1, text);
    assert.match(text, /Loading models for the new settings/, text);
});
