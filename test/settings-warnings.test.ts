// bedrock.json diagnostics: an unknown key is ignored with a warning, a bad known value still disables the provider and
// names the field, and a file that is not JSON is reported instead of silently vanishing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";

type Hook = (event: unknown, ctx: unknown) => unknown;

async function start(dir: string) {
    const hooks = new Map<string, Hook[]>();
    const providers: unknown[] = [];
    const notices: Array<{ text: string; type?: string }> = [];
    const pi = {
        on(name: string, hook: Hook) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: unknown) {
            if (typeof provider !== "string") providers.push(provider);
        },
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    const handle = await createBedrockProvider({
        env: { HOME: dir, PI_CODING_AGENT_DIR: dir },
        listProfiles: async () => [],
        catalog: { load: () => undefined, refresh: async () => "ok" },
        backgroundRefresh: false,
        usageEvents: false,
    })(pi as never);
    const ctx = {
        mode: "rpc",
        model: undefined,
        sessionManager: { getBranch: () => [], getSessionId: () => "test" },
        modelRegistry: { find: () => undefined },
        ui: { notify: (text: string, type?: string) => notices.push({ text, type }) },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    return { handle, providers, notices };
}

test("an unknown setting is ignored with a warning that names it and the file", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-settings-unknown-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "bedrock.json");
    writeFileSync(file, JSON.stringify({ profile: "my-profile", typo: 1 }));
    const { handle, providers, notices } = await start(dir);
    assert.ok(handle, "the provider still starts");
    assert.equal(providers.length, 1);
    const warning = notices.find((notice) => notice.type === "warning");
    assert.ok(warning);
    assert.match(warning.text, /typo/);
    assert.match(warning.text, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(warning.text, /docs\/settings\.md/);
});

test("a known field with a bad value still names the field and disables the provider", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-settings-bad-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "bedrock.json"), JSON.stringify({ regions: [] }));
    const { handle, notices } = await start(dir);
    assert.equal(handle, undefined);
    const warning = notices.find((notice) => notice.type === "warning");
    assert.ok(warning);
    assert.match(warning.text, /bedrock\.regions/);
});

test("a file that is not valid JSON is reported and the defaults still run", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-settings-json-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "bedrock.json");
    writeFileSync(file, "{ not json");
    const { handle, notices } = await start(dir);
    assert.ok(handle, "the provider still starts with defaults");
    const warning = notices.find((notice) => notice.type === "warning");
    assert.ok(warning);
    assert.match(warning.text, /not valid JSON/);
    assert.match(warning.text, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
