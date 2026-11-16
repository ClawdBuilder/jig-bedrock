import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createBedrockProvider } from "../src/provider.ts";

test("a mistyped region is refused at /bedrock set and a new-looking one warns", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-region-setting-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    const env = { HOME: dir, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(dir, "cache") };
    const raw = {
        profile: "fixture",
        tagKey: "Team",
        tagValue: "fixture",
        regions: ["us-east-1"],
    };
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify(raw));
    const resolved = loadConfig({ raw, env, agentDir: agent });
    assert.ok(resolved.config);
    const commands = new Map<string, any>();
    const pi = {
        on() {},
        registerProvider() {},
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async () => true,
    };
    await createBedrockProvider({
        env,
        config: resolved.config,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        verifyProfile: async () => ({ ok: true }),
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
    const command = commands.get("bedrock");
    assert.ok(command);
    await command.handler("set regions us-east-9", ctx);
    const rejected = notices.join("\n");
    assert.match(rejected, /us-east-9 is not an AWS region; did you mean us-east-1/);
    assert.deepEqual(JSON.parse(readFileSync(join(agent, "bedrock.json"), "utf8")).regions, ["us-east-1"]);

    notices.length = 0;
    await command.handler("set regions eu-west-4", ctx);
    const accepted = notices.join("\n");
    assert.match(accepted, /eu-west-4 is not in the known AWS region list; using it anyway/);
    assert.deepEqual(JSON.parse(readFileSync(join(agent, "bedrock.json"), "utf8")).regions, ["eu-west-4"]);
});
