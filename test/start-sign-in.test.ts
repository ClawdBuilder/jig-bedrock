// The start-up check: true signs in at once; false still checks read-only and says the models are not loaded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSignInAtStart } from "../src/start-sign-in.ts";

type Hook = (event: unknown, ctx: any) => unknown;
/** Let every queued microtask and macrotask (the setImmediate in the sign-in) run, without a wall-clock wait. */
async function settle(turns = 25): Promise<void> {
    for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
}

async function scenario(signInAtStart: boolean, uiMode = "tui") {
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
    });
    const ctx = {
        hasUI: true,
        mode: uiMode,
        ui: { notify: (text: string) => notices.push(text) },
    };
    await hooks.get("session_start")!({ reason: "startup" }, ctx);
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

test("false still checks read-only and shows the not-loaded notice", async () => {
    const result = await scenario(false);
    assert.equal(result.checked, 1);
    assert.equal(result.recovered, 0);
    assert.equal(result.refreshed, 0);
    assert.deepEqual(result.notices, ["Bedrock models not loaded yet; run /aws-login, then /bedrock-refresh."]);
});

test("print mode has no check and no notice", async () => {
    const result = await scenario(false, "print");
    assert.equal(result.checked, 0);
    assert.equal(result.recovered, 0);
    assert.equal(result.notices.length, 0);
});
