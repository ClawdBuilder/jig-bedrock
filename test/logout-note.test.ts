// The /logout note in /bedrock status is true only for a credential Pi stored and then removed in this session: a
// hand-written bedrock.json never had one, so it must not be told to unset its profile.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";

async function start(t: test.TestContext, options: { stored: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-logout-note-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify({ profile: "fixture", regions: ["us-east-1"] }));
    const auth = join(agent, "auth.json");
    if (options.stored) writeFileSync(auth, JSON.stringify({ "jig-bedrock": { type: "api_key", key: "fixture" } }));
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
        on(name: string, hook: (event: unknown, ctx: unknown) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider() {},
        registerCommand(name: string, value: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async () => true,
    };
    await createBedrockProvider({
        env: { HOME: dir, PI_CODING_AGENT_DIR: agent },
        config: {
            profile: "fixture",
            regions: ["us-east-1"],
            agentDir: agent,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: { load: () => undefined, refresh: async () => "ok", status: () => "ok" } as never,
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
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
    const command = commands.get("bedrock");
    assert.ok(command, "the /bedrock command is registered");
    return { auth, command, ctx, notices };
}

test("a hand-written bedrock.json is not told that /logout removed its profile", async (t) => {
    const s = await start(t, { stored: false });
    await s.command.handler("status", s.ctx);
    assert.doesNotMatch(s.notices.join("\n"), /\/bedrock unset profile/, s.notices.join("\n"));
});

test("a credential that existed at start and was removed gives the /logout note", async (t) => {
    const s = await start(t, { stored: true });
    s.notices.length = 0;
    await s.command.handler("status", s.ctx);
    assert.doesNotMatch(s.notices.join("\n"), /\/bedrock unset profile/, s.notices.join("\n"));
    // Pi's /logout removes this provider's credential from auth.json.
    writeFileSync(s.auth, "{}");
    s.notices.length = 0;
    await s.command.handler("status", s.ctx);
    assert.match(s.notices.join("\n"), /\/bedrock unset profile/, s.notices.join("\n"));
});
