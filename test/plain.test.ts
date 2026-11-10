// Plain Pi: the extension starts the provider and its commands from bedrock.json and the environment alone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jigBedrock } from "../src/index.ts";

test("plain Pi registers the provider and commands", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-plain-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const providers: unknown[] = [];
    const commands: string[] = [];
    const pi = {
        on() {},
        registerProvider(provider: unknown) {
            providers.push(provider);
        },
        registerCommand(name: string) {
            commands.push(name);
        },
        events: { emit() {} },
        setModel: () => false,
    };
    await (jigBedrock({ env: { JIG_BEDROCK_TEAM: "my-team", PI_CODING_AGENT_DIR: dir, HOME: dir } }) as never)(
        pi as never,
    );
    assert.equal(providers.length > 0, true, "the Bedrock provider is registered");
    for (const name of ["bedrock-refresh", "bedrock-usage", "bedrock-doctor"]) assert.ok(commands.includes(name), name);
});

test("plain Pi applies bedrock.json, and JIG_BEDROCK_PROFILE overrides it", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-plain-settings-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "bedrock.json"), JSON.stringify({ profile: "file-profile", regions: ["us-east-1"] }));

    async function profileFrom(env: NodeJS.ProcessEnv): Promise<{ profile?: string; source?: string }> {
        const { pi, hooks, providers } = harness();
        await (
            jigBedrock({
                env: { HOME: dir, PI_CODING_AGENT_DIR: dir, ...env },
                listProfiles: async () => ["file-profile", "env-profile"],
            }) as never
        )(pi as never);
        for (const hook of hooks.get("session_start") ?? [])
            await (hook as never)(
                {},
                {
                    sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionDir: () => dir },
                    ui: { notify() {} },
                },
            );
        const provider = providers.find((entry: any) => entry?.id === "jig-bedrock") as any;
        assert.ok(provider, "the provider is registered");
        const auth = await provider.auth.apiKey.resolve({
            ctx: { env: async () => undefined, fileExists: async () => false },
            signal: new AbortController().signal,
        });
        return { profile: auth?.env?.AWS_PROFILE, source: auth?.source };
    }

    assert.deepEqual(await profileFrom({}), { profile: "file-profile", source: "bedrock.profile" });
    assert.deepEqual(await profileFrom({ JIG_BEDROCK_PROFILE: "env-profile" }), {
        profile: "env-profile",
        source: "JIG_BEDROCK_PROFILE",
    });
});

/** The hooks, commands and providers a fake Pi records. */
function harness() {
    const hooks = new Map<string, Array<(...args: never[]) => unknown>>();
    const providers: unknown[] = [];
    const pi = {
        on(name: string, hook: (...args: never[]) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: unknown) {
            if (typeof provider !== "string") providers.push(provider);
        },
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    return { pi, hooks, providers };
}
