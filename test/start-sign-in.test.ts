// The start-up check: true signs in at once; false still checks read-only and says what did not load (and whether the
// saved models are already in /model).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerSignInAtStart } from "../src/start-sign-in.ts";
import { hostImport } from "./support/pi-host.ts";

type Hook = (event: unknown, ctx: any) => unknown;
/** Let every queued microtask and macrotask (the setImmediate in the sign-in) run, without a wall-clock wait. */
async function settle(turns = 25): Promise<void> {
    for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
}

async function scenario(signInAtStart: boolean, uiMode = "tui", models = 0) {
    const hooks = new Map<string, Hook>();
    const notices: string[] = [];
    let checked = 0;
    let recovered = 0;
    let refreshed = 0;
    const pi = {
        on: (name: string, hook: Hook) => {
            hooks.set(name, hook);
        },
    };
    registerSignInAtStart(pi as any, {
        signInAtStart,
        profile: () => "work",
        recover: async () => {
            recovered++;
        },
        check: async () => {
            checked++;
            return "sign-in";
        },
        refresh: async () => {
            refreshed++;
        },
        models: () => models,
    });
    const ctx = {
        hasUI: true,
        mode: uiMode,
        ui: { notify: (text: string) => notices.push(text) },
    };
    await hooks.get("session_start")?.({ reason: "startup" }, ctx);
    await settle();
    return { checked, recovered, refreshed, notices };
}

test("true signs in at start-up", async () => {
    const result = await scenario(true);
    assert.equal(result.checked, 1);
    assert.equal(result.recovered, 1);
    assert.equal(result.refreshed, 1);
    assert.match(result.notices.join("\n"), /browser opens/);
});

test("false still checks read-only and says no models are loaded", async () => {
    const result = await scenario(false);
    assert.equal(result.checked, 1);
    assert.equal(result.recovered, 0);
    assert.equal(result.refreshed, 0);
    assert.deepEqual(result.notices, [
        "AWS sign-in for work has expired; no models are loaded yet, so run /bedrock login.",
    ]);
});

test("print mode has no check and no notice", async () => {
    const result = await scenario(false, "print");
    assert.equal(result.checked, 0);
    assert.equal(result.recovered, 0);
    assert.equal(result.notices.length, 0);
});

test("an expired sign-in at start does not call the saved models unloaded", async () => {
    const { createBedrockProvider } = await import("../src/provider.ts");
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    const foundation = builtinProviders()
        .find((provider: { id: string }) => provider.id === "amazon-bedrock")
        .getModels()[0];
    const dir = mkdtempSync(join(tmpdir(), "bedrock-sign-in-start-"));
    try {
        const account = "123456789012";
        const cache = {
            schema: 1,
            aws_profile: "fixture",
            account_id: account,
            regions: ["us-east-1"],
            fetched_at: Math.floor(Date.now() / 1000),
            profiles: [1, 2].map((number) => ({
                arn: `arn:aws:bedrock:us-east-1:${account}:application-inference-profile/p${number}`,
                profile_name: `Fixture ${number}`,
                foundation_model_id: foundation.id,
                region: "us-east-1",
            })),
        };
        const hooks = new Map<string, Hook[]>();
        const notices: string[] = [];
        const pi = {
            on(name: string, hook: Hook) {
                hooks.set(name, [...(hooks.get(name) ?? []), hook]);
            },
            registerProvider() {},
            registerCommand() {},
            events: { emit() {} },
            setModel: async () => true,
        };
        const controller = await createBedrockProvider({
            config: {
                profile: "fixture",
                regions: ["us-east-1"],
                agentDir: dir,
                ssoLoginCommand: [],
                signInAtStart: false,
            },
            catalog: { load: () => cache, refresh: async () => "ok", status: () => "ok" },
            listProfiles: async () => ["fixture"],
            ssoCheck: async () => "sign-in",
            ssoRecover: async () => {},
            budget: { load: () => undefined, refresh: async () => {} },
            backgroundRefresh: false,
            usageEvents: false,
        } as never)(pi as never);
        assert.equal(controller?.models.length, 2, "both saved models are registered");
        const ctx = {
            hasUI: true,
            mode: "rpc",
            ui: { notify: (text: string) => notices.push(text), setStatus() {} },
            sessionManager: { getBranch: () => [], getSessionId: () => "s" },
            modelRegistry: { find: () => undefined },
        };
        for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
        await settle();
        const text = notices.join("\n");
        assert.match(text, /AWS sign-in for fixture has expired/, text);
        assert.match(text, /the 2 models in \/model are still loaded/, text);
        assert.doesNotMatch(text, /not loaded|no models are loaded/, text);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
