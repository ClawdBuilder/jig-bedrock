// The install order must not matter: a fake jig-core that is present before the provider, or loads after it, applies the
// same `bedrock` section, registers the section, and never leaves the "ignored this session" message behind.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jigBedrock } from "../src/index.ts";
import { publishJigForTest, resetJigForTest } from "./support/jig.ts";

type Hook = (...args: never[]) => unknown;

function fakeJig(section: Record<string, unknown>, registered: string[]) {
    return {
        config: {
            registerSection(name: string) {
                registered.push(name);
            },
            section() {
                return section;
            },
        },
    };
}

async function run(order: "jig-first" | "provider-first", dir: string) {
    resetJigForTest();
    const hooks = new Map<string, Hook[]>();
    const providers: any[] = [];
    const notices: string[] = [];
    const registered: string[] = [];
    const api = fakeJig({ profile: "jig-profile", regions: ["us-east-1"] }, registered);
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
    if (order === "jig-first") publishJigForTest(api);
    await (
        jigBedrock({
            env: { HOME: dir, PI_CODING_AGENT_DIR: dir },
            listProfiles: async () => ["jig-profile"],
        }) as never
    )(pi as never);
    if (order === "provider-first") publishJigForTest(api);
    for (const hook of hooks.get("session_start") ?? [])
        await hook({ reason: "startup" }, {
            sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionDir: () => dir },
            ui: { notify: (text: string) => notices.push(text) },
        } as never);
    const provider = providers.find((entry) => entry?.id === "jig-bedrock");
    assert.ok(provider, "the provider is registered");
    const auth = await provider.auth.apiKey.resolve({
        ctx: { env: async () => undefined, fileExists: async () => false },
        signal: new AbortController().signal,
    });
    resetJigForTest();
    return { auth, registered, notices };
}

test("the Jig bedrock section applies with jig-core loaded first or last", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-order-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = await run("jig-first", dir);
    const last = await run("provider-first", dir);
    for (const result of [first, last]) {
        assert.deepEqual(result.auth, { auth: {}, env: { AWS_PROFILE: "jig-profile" }, source: "bedrock.profile" });
        assert.deepEqual(result.registered, ["bedrock"], "the section is registered whenever jig-core appears");
        assert.doesNotMatch(result.notices.join("\n"), /ignored this session/);
    }
    assert.deepEqual(first.auth, last.auth, "both install orders produce the same profile");
});
