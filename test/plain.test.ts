// Plain Pi, without Jig: the extension starts the provider and its commands from environment settings alone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jigBedrock } from "../src/index.ts";

test("plain Pi registers the provider and commands with no jig-core", async (t) => {
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

test("the notice names PI_CODING_AGENT_DIR when a project program setting is ignored", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-notice-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "bedrock.json"), JSON.stringify({ team: "my-team", usageDir: "/user/usage" }));
    const hooks = new Map<string, Array<(...args: never[]) => void>>();
    const notices: string[] = [];
    const api = {
        config: {
            registerSection() {},
            section: () => ({ team: "my-team", usageDir: "/project/usage", browser: "/project/browser" }),
        },
    } as never;
    const pi = {
        on(name: string, fn: (...args: never[]) => void) {
            hooks.set(name, [...(hooks.get(name) ?? []), fn]);
        },
        registerProvider() {},
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    await (
        jigBedrock({
            api,
            env: { JIG_BEDROCK_TEAM: "my-team", PI_CODING_AGENT_DIR: dir, HOME: dir },
        }) as never
    )(pi as never);
    for (const fn of hooks.get("session_start") ?? [])
        await (fn as never)(
            {},
            {
                sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionDir: () => dir },
                ui: { notify: (text: string) => notices.push(text) },
            },
        );
    assert.match(notices.join("\n"), new RegExp(`${dir}/bedrock.json`));
    assert.match(notices.join("\n"), /ignores usageDir and browser/);
});

test("jig-core loading after the provider warns once that its section is ignored", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-late-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const hooks = new Map<string, Array<(...args: never[]) => void>>();
    const notices: string[] = [];
    const pi = {
        on(name: string, fn: (...args: never[]) => void) {
            hooks.set(name, [...(hooks.get(name) ?? []), fn]);
        },
        registerProvider() {},
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    await (jigBedrock({ env: { JIG_BEDROCK_TEAM: "my-team", PI_CODING_AGENT_DIR: dir, HOME: dir } }) as never)(
        pi as never,
    );
    const { publishJig, withdrawJig } = await import("../src/jig/client.ts");
    const api = { config: { registerSection() {}, section: () => undefined } };
    publishJig(api as never);
    for (const fn of hooks.get("session_start") ?? [])
        await (fn as never)(
            {},
            {
                sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionDir: () => dir },
                ui: { notify: (text: string) => notices.push(text) },
            },
        );
    withdrawJig(api as never);
    assert.match(notices.join("\n"), /jig-core loaded after the Bedrock provider/);
});
