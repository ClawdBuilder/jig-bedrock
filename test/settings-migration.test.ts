// One-release migration: a 0.2.x jig.json is read only to offer a copy; bedrock.json is the source, and the copy is
// written once, privately, and never over an existing file.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jigBedrock } from "../src/index.ts";

type Hook = (event: unknown, ctx: unknown) => unknown;
type Command = (args: string, ctx: unknown) => Promise<void>;

async function harness(dir: string) {
    const hooks = new Map<string, Hook[]>(),
        commands = new Map<string, Command>(),
        notices: string[] = [];
    const pi = {
        on(name: string, hook: Hook) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider() {},
        registerCommand(name: string, options: { handler: Command }) {
            commands.set(name, options.handler);
        },
        setModel: () => false,
    };
    await (
        jigBedrock({
            env: { PI_CODING_AGENT_DIR: dir, HOME: dir },
            config: {
                team: "fixture",
                profile: "fixture",
                regions: ["us-east-1"],
                agentDir: dir,
                ssoLoginCommand: [],
                signInAtStart: false,
            },
            catalog: { load: () => undefined, refresh: async () => "ok" },
            listProfiles: async () => [],
            backgroundRefresh: false,
            ssoRecover: async () => {},
            budget: { load: () => undefined, refresh: async () => {} },
        }) as never
    )(pi as never);
    const ctx = {
        mode: "rpc",
        model: undefined,
        sessionManager: { getBranch: () => [], getSessionId: () => "migration" },
        ui: { notify: (text: string) => notices.push(text) },
        modelRegistry: { find: () => undefined },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ type: "session_start" }, ctx);
    return { commands, notices, ctx };
}

test("the migration notice appears once and /bedrock migrate copies generic keys", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-migrate-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const old = join(dir, "jig.json");
    const destination = join(dir, "bedrock.json");
    writeFileSync(
        old,
        JSON.stringify({ bedrock: { team: "my-team", regions: ["us-east-1"], usageDir: "/tmp/usage" } }),
    );
    const h = await harness(dir);
    assert.ok(
        h.notices.includes(
            "Your Bedrock settings are in jig.json. This version reads bedrock.json only. Run /bedrock migrate to copy them.",
        ),
        h.notices.join("\n"),
    );
    await h.commands.get("bedrock")?.("migrate", h.ctx);
    const written = JSON.parse(readFileSync(destination, "utf8")) as Record<string, unknown>;
    assert.equal(written.tagKey, "Team");
    assert.equal(written.tagValue, "my-team");
    assert.equal(written.activeTagKey, "Active");
    assert.equal(written.activeTagValue, "true");
    assert.equal(written.team, undefined);
    assert.equal(written.usageDir, undefined, "the removed usageDir key is not copied");
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(old, "utf8")).bedrock.team, "my-team", "jig.json is left as it is");

    writeFileSync(destination, '{"edited":true}\n');
    await h.commands.get("bedrock")?.("migrate", h.ctx);
    assert.equal(readFileSync(destination, "utf8"), '{"edited":true}\n', "an existing file is never overwritten");
    assert.ok(h.notices.some((notice) => notice.includes("already exists")));
});

test("bedrock.json accepts top-level keys and a wrapped bedrock object", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-source-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "bedrock.json"), JSON.stringify({ bedrock: { profile: "wrapped-profile" } }));
    const h = await harness(dir);
    assert.ok(!h.notices.some((notice) => notice.includes("jig.json")), "no migration notice when the file exists");
});
