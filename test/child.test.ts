import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwsDiscovery, type Runner } from "../src/aws-discovery.ts";
import { isSubagentChild } from "../src/child.ts";
import { createJigBedrock } from "../src/provider.ts";

type Hook = (...args: any[]) => any;

test("a subagent child is recognised by PI_SUBAGENT_ID, and by the older PI_SUBAGENT_CHILD", () => {
    assert.equal(isSubagentChild({}), false);
    assert.equal(isSubagentChild({ PI_SUBAGENT_ID: "" }), false);
    assert.equal(isSubagentChild({ PI_SUBAGENT_ID: "  " }), false);
    assert.equal(isSubagentChild({ PI_SUBAGENT_ID: "scout-1" }), true);
    assert.equal(isSubagentChild({ PI_SUBAGENT_CHILD: "1" }), true);
    assert.equal(isSubagentChild({ PI_SUBAGENT_CHILD: "0" }), false);
});

async function start(t: any, env: NodeJS.ProcessEnv) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-child-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const hooks = new Map<string, Hook[]>(),
        emitted: string[] = [],
        calls = { catalog: 0, budget: 0 };
    const pi: any = {
        on: (name: string, fn: Hook) => hooks.set(name, [...(hooks.get(name) || []), fn]),
        registerProvider() {},
        registerCommand() {},
        events: { emit: (channel: string) => emitted.push(channel) },
        setModel: () => false,
    };
    await createJigBedrock({
        env,
        config: {
            team: "fixture",
            profile: "fixture",
            regions: ["us-east-1"],
            agentDir: dir,
            usageDir: dir,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: {
            load: () => undefined,
            refresh: async () => {
                calls.catalog++;
                return "ok";
            },
        },
        ssoRecover: async () => {},
        budget: {
            load: () => undefined,
            refresh: async () => {
                calls.budget++;
            },
        },
    })(pi);
    const ctx: any = {
        mode: "tui",
        model: { provider: "jig-bedrock", id: "m" },
        sessionManager: { getBranch: () => [], getSessionId: () => "session" },
        ui: { notify() {} },
        modelRegistry: { find: () => undefined },
    };
    for (const fn of hooks.get("session_start") || []) await fn({ type: "session_start" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const shutdown = async () => {
        for (const fn of hooks.get("session_shutdown") || []) await fn({}, ctx);
    };
    t.after(shutdown);
    return { calls, emitted, hooks, shutdown };
}
test("an interactive session refreshes the catalog and polls usage program in the background", async (t) => {
    const h = await start(t, {});
    assert.equal(h.calls.catalog, 1);
    assert.equal(h.calls.budget, 1);
    assert.ok(h.emitted.includes("jig-bedrock:usage"));
    assert.ok(h.hooks.has("model_select"));
});
for (const env of [{ PI_SUBAGENT_ID: "scout-1" }, { PI_SUBAGENT_CHILD: "1" }]) {
    test(`a subagent child (${Object.keys(env)[0]}) skips the catalogue refresh, the usage program poll and the usage events`, async (t) => {
        const h = await start(t, env);
        assert.equal(h.calls.catalog, 0);
        assert.equal(h.calls.budget, 0);
        assert.ok(!h.emitted.includes("jig-bedrock:usage"));
        assert.equal(h.hooks.has("model_select") && h.hooks.get("model_select")!.length > 1, false);
        assert.ok(h.emitted.includes("jig-bedrock:provider"), "the child still announces its models");
    });
}
test("a fresh catalogue skips STS in every process; an expired or forced one asks who the caller is", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-sts-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const account = "123456789012",
        calls: string[][] = [];
    let now = Date.now();
    const runner: Runner = async (_program, args) => {
        calls.push(args);
        if (args.includes("get-caller-identity")) return JSON.stringify({ Account: account });
        return JSON.stringify({ ResourceTagMappingList: [] });
    };
    const source = createAwsDiscovery(
        {
            team: "fixture",
            profile: "fixture",
            regions: ["us-east-1"],
            usageDir: dir,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        runner,
        join(dir, "catalog.json"),
        () => now,
    );
    const asked = () => calls.filter((a) => a.includes("get-caller-identity")).length;
    assert.equal(await source.refresh(), "ok");
    assert.equal(asked(), 1);
    now += 3_600_000;
    calls.length = 0;
    assert.equal(await source.refresh(), "ok");
    assert.equal(calls.length, 0);
    now += 86_400_000;
    assert.equal(await source.refresh(), "ok");
    assert.equal(asked(), 1);
});
