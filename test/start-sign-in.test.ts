// The start-up check's choice: ask before opening a browser, sign in at once, or leave it to a request or /aws-login.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSignInAtStart } from "../src/start-sign-in.ts";

type Hook = (event: unknown, ctx: any) => unknown;
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

async function scenario(mode: boolean | "ask", yes = true, options: { hasUI?: boolean; uiMode?: string } = {}) {
    const hooks = new Map<string, Hook>();
    const notices: string[] = [];
    let confirms = 0;
    let recovered = 0;
    let refreshed = 0;
    let checked = 0;
    const pi = {
        on: (name: string, hook: Hook) => {
            hooks.set(name, hook);
        },
    };
    registerSignInAtStart(pi as any, {
        mode,
        profile: "work",
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
        hasUI: options.hasUI ?? true,
        mode: options.uiMode ?? "tui",
        ui: {
            confirm: async (title: string, message: string) => {
                confirms++;
                assert.equal(title, "AWS sign-in");
                assert.equal(message, "AWS sign-in for work has expired. Sign in now?");
                return yes;
            },
            notify: (text: string) => notices.push(text),
        },
    };
    await hooks.get("session_start")!({ reason: "startup" }, ctx);
    await pause();
    return { checked, confirms, recovered, refreshed, notices };
}

test('"ask" with yes opens the shared recovery once', async () => {
    const result = await scenario("ask", true);
    assert.equal(result.confirms, 1);
    assert.equal(result.recovered, 1);
    assert.equal(result.refreshed, 1);
    assert.match(result.notices.join("\n"), /browser opens/);
});

test('"ask" with no opens nothing and says where to sign in', async () => {
    const result = await scenario("ask", false);
    assert.equal(result.confirms, 1);
    assert.equal(result.recovered, 0);
    assert.equal(result.refreshed, 0);
    assert.deepEqual(result.notices, ["Bedrock models not loaded yet; run /aws-login, then /bedrock-refresh."]);
});

test("true signs in at once, without asking", async () => {
    const result = await scenario(true);
    assert.equal(result.confirms, 0);
    assert.equal(result.recovered, 1);
});

test("false still checks read-only, opens nothing, and shows the models notice", async () => {
    const result = await scenario(false);
    assert.equal(result.checked, 1);
    assert.equal(result.confirms, 0);
    assert.equal(result.recovered, 0);
    assert.deepEqual(result.notices, ["Bedrock models not loaded yet; run /aws-login, then /bedrock-refresh."]);
});

test("print mode has no question and opens nothing", async () => {
    const result = await scenario("ask", true, { uiMode: "print" });
    assert.equal(result.confirms, 0);
    assert.equal(result.recovered, 0);
    assert.equal(result.notices.length, 0);
});
