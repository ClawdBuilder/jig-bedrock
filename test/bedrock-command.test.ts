/* biome-ignore-all lint/style/noNonNullAssertion: test assertions */
// The one command: every sub-command, the completions, the old names and the always-present broken settings path.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerBedrockCommands, registerBrokenCommands } from "../src/commands.ts";
import { SpendTracker } from "../src/spend.ts";

const config = {
    team: "fixture",
    profile: "fixture",
    regions: ["us-east-1"],
    monthlyBudgetUsd: 100,
    ssoLoginCommand: [],
    signInAtStart: false,
    agentDir: "/tmp",
};
const model = {
    id: "claude-sonnet-5-5",
    api: "anthropic-messages",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
    arn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/p",
    foundationModelId: "anthropic.claude-sonnet-5-5",
    rateSource: "Pi registry",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
function harness(t: { after(fn: () => void): void }, env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), "bedrock-command-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const settings = { HOME: root, PI_CODING_AGENT_DIR: root, LANG: "C.UTF-8", TERM: "xterm-256color", ...env };
    const notices: string[] = [];
    const commands = new Map<
        string,
        { handler: (args: string, ctx: never) => Promise<void>; getArgumentCompletions?: unknown }
    >();
    const pi = {
        registerCommand(name: string, value: { handler: (args: string, ctx: never) => Promise<void> }) {
            commands.set(name, value);
        },
    };
    const spend = new SpendTracker({ ...config, agentDir: root }, settings, () => Date.UTC(2026, 10, 15, 12));
    const result = registerBedrockCommands(pi as never, {
        config: { ...config, agentDir: root },
        spend,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        models: () => [model as never],
        env: settings,
        refresh: async () => "ok",
        lastChoice: () => ({ profile: "fixture", exists: true }),
        unavailable: () => [],
        presetNames: () => ["dev", "work"],
        ...extra,
    });
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s" },
    };
    return { root, settings, notices, commands, result, ctx };
}

test("every sub-command prints a titled block and usage has no stale Next", async (t) => {
    const h = harness(t, {});
    for (const args of [
        "status",
        "models",
        "settings",
        "help",
        "usage",
        "usage day",
        "budget",
        "budget 200",
        "budget off",
    ]) {
        await h.result.bedrock(args, h.ctx as never);
    }
    assert.ok(h.notices.length >= 9);
    for (const text of h.notices) {
        assert.match(text, /^Bedrock /);
        assert.ok(
            text.split("\n").every((line) => line.length <= 100),
            text,
        );
    }
    assert.doesNotMatch(h.notices.find((text) => text.startsWith("Bedrock spend")) ?? "", /^Next:/m);
    assert.match(h.notices.find((text) => text.startsWith("Bedrock spend")) ?? "", /· this machine's Pi sessions/);
    assert.match(
        h.notices.find((text) => text.startsWith("Bedrock models")) ?? "",
        /claude-sonnet-5-5 .*us-east-1 .*Converse/,
    );
});

test("set and unset write the settings file and apply", async (t) => {
    const h = harness(t, {});
    await h.result.bedrock("set api converse", h.ctx as never);
    assert.match(readFileSync(join(h.root, "bedrock.json"), "utf8"), /"api": "converse"/);
    await h.result.bedrock("unset api", h.ctx as never);
    assert.doesNotMatch(readFileSync(join(h.root, "bedrock.json"), "utf8"), /"api"/);
});

test("completions list sub-commands and setting names", () => {
    const h = harness({ after() {} }, {});
    assert.ok(h.result.completions("us").some((item) => item.value === "usage"));
    assert.ok(h.result.completions("set pro").some((item) => item.value === "set profile" && item.label === "profile"));
    assert.ok(h.result.completions("unset pro").some((item) => item.value === "unset profile"));
    for (const [prefix, command] of [
        ["set r", "set"],
        ["unset r", "unset"],
        ["use d", "use"],
        ["preset remove d", "preset remove"],
    ] as const) {
        const values = h.result.completions(prefix);
        assert.ok(values.length > 0, prefix);
        assert.ok(
            values.every((item) => item.value.startsWith(`${command} `)),
            prefix,
        );
    }
});

test("the removed command names are not registered", (t) => {
    const h = harness(t, {});
    for (const name of ["bedrock-doctor", "bedrock-refresh", "bedrock-usage", "bedrock-stats", "bedrock-profiles"])
        assert.equal(h.commands.has(name), false, name);
});

test("broken settings still register /bedrock and repair through set", async (t) => {
    const h = harness(t, {});
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const pi = { registerCommand: (name: string, value: never) => commands.set(name, value) };
    const file = join(h.root, "bedrock.json");
    writeFileSync(file, JSON.stringify({ regions: [] }));
    const handler = registerBrokenCommands(pi as never, {
        file,
        error: "regions must contain 1-16 unique AWS region names.",
        env: h.settings,
    });
    await handler("status", h.ctx as never);
    assert.match(h.notices[0]!, /^Bedrock · 1 problem/);
    await handler("set regions us-east-1", h.ctx as never);
    assert.match(readFileSync(file, "utf8"), /"regions": \[/);
    assert.match(h.notices.at(-1) ?? "", /Run \/reload/);
    assert.equal(commands.has("bedrock-doctor"), false);
});

test("a broken settings file still registers /bedrock and no old names", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bedrock-broken-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "bedrock.json"), JSON.stringify({ regions: [] }));
    const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
        on: (name: string, hook: (event: unknown, ctx: unknown) => unknown) =>
            hooks.set(name, [...(hooks.get(name) ?? []), hook]),
        registerCommand: (name: string, value: never) => commands.set(name, value),
        registerProvider() {},
        setModel: () => false,
    };
    const { createBedrockProvider } = await import("../src/provider.ts");
    const handle = await createBedrockProvider({ env: { HOME: root, PI_CODING_AGENT_DIR: root } })(pi as never);
    assert.equal(handle, undefined);
    assert.ok(commands.has("bedrock"));
    assert.equal(commands.has("bedrock-doctor"), false);
    const notices: string[] = [];
    await commands.get("bedrock")?.handler("status", {
        hasUI: true,
        mode: "rpc",
        ui: { notify: (text: string) => notices.push(text) },
    } as never);
    assert.match(notices[0]!, /^Bedrock · 1 problem/);
    assert.match(notices[0]!, /regions/);
});

test("the status screen is one whole block with no spend-command row", async (t) => {
    const h = harness(t, {});
    await h.result.bedrock("status", h.ctx as never);
    assert.equal(
        h.notices.at(-1),
        [
            "Bedrock · ready",
            "✓ AWS profile: fixture · signed in",
            "✓ Models: 1 loaded",
            "– Selected model: none chosen",
            "✓ Spend: Nov $0.00 of $100",
        ].join("\n"),
    );
});

test("/bedrock login prints the cause it has, and never a placeholder profile", async (t) => {
    const withProfile = harness(
        t,
        {},
        {
            login: async () => {
                throw new Error("sign-in expired for the selected profile");
            },
        },
    );
    await withProfile.result.bedrock("login", withProfile.ctx as never);
    assert.match(withProfile.notices.join("\n"), /Sign-in did not finish: sign-in expired for the selected profile/);
    assert.match(withProfile.notices.join("\n"), /aws sso login --profile fixture/);

    const noProfile = harness(
        t,
        {},
        {
            config: { ...config, profile: undefined },
            login: async () => {
                throw new Error("No AWS profile is chosen.");
            },
        },
    );
    await noProfile.result.bedrock("login", noProfile.ctx as never);
    const text = noProfile.notices.join("\n");
    assert.match(text, /choose an AWS profile with \/login/);
    assert.doesNotMatch(text, /my-profile/);
});

test("one command table feeds help, completions and the typo guard", async (t) => {
    const h = harness(t, {});
    const pre = h.result.completions("pre");
    assert.ok(
        pre.some((item) => item.value === "preset"),
        JSON.stringify(pre),
    );
    assert.ok(h.result.completions("us").some((item) => item.value === "use"));
    await h.result.bedrock("help use", h.ctx as never);
    assert.match(h.notices.at(-1) ?? "", /Usage: \/bedrock use \[name\]/);
    await h.result.bedrock("prset", h.ctx as never);
    assert.equal(h.notices.length >= 1, true);
    assert.match(h.notices.at(-1) ?? "", /Did you mean preset\?/);
    assert.match(h.notices.at(-1) ?? "", /Next: \/bedrock help/);
});

test("commands with no arguments refuse stray words with their usage", async (t) => {
    const h = harness(t, {});
    for (const [args, usage] of [
        ["status extra", "status"],
        ["models extra", "models"],
        ["refresh extra", "refresh"],
        ["login extra", "login"],
        ["settings extra", "settings"],
    ] as const) {
        await h.result.bedrock(args, h.ctx as never);
        assert.match(h.notices.at(-1) ?? "", new RegExp(`Usage: /bedrock ${usage.replace("[", "\\[")}`));
    }
});

test("unknown settings and periods name the nearest valid word", async (t) => {
    const h = harness(t, {});
    await h.result.bedrock("set region us-east-1", h.ctx as never);
    assert.match(h.notices.at(-1) ?? "", /Unknown setting region\. Did you mean regions\?/);
    await h.result.bedrock("usage weak", h.ctx as never);
    assert.match(h.notices.at(-1) ?? "", /Unknown period weak\. Did you mean week\?/);
});

test("a print-mode refresh with N models prints N and no progress header", async (t) => {
    const h = harness(t, {});
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    try {
        await h.result.bedrock("refresh", {
            hasUI: false,
            mode: "json",
            signal: new AbortController().signal,
            sessionManager: { getSessionId: () => "s" },
        } as never);
    } finally {
        process.stdout.write = original;
    }
    const text = writes.join("");
    assert.match(text, /✓ 1 model loaded/);
    assert.doesNotMatch(text, /Reading the models/);
});

test("print-mode doctor omits the progress line", async (t) => {
    const h = harness(t, {});
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    try {
        await h.result.bedrock("doctor offline", {
            hasUI: false,
            mode: "json",
            signal: new AbortController().signal,
            sessionManager: { getSessionId: () => "s" },
        } as never);
    } finally {
        process.stdout.write = original;
    }
    assert.doesNotMatch(writes.join(""), /Checking AWS/);
});

test("a tag pair can be set and unset in one command", async (t) => {
    const h = harness(t, {});
    await h.result.bedrock("set activeTagKey Active", h.ctx as never);
    assert.match(
        h.notices.at(-1) ?? "",
        /activeTagKey and activeTagValue go together: \/bedrock set activeTagKey <key> activeTagValue <value>/,
    );
    await h.result.bedrock("set activeTagKey Active activeTagValue true", h.ctx as never);
    let saved = JSON.parse(readFileSync(join(h.root, "bedrock.json"), "utf8"));
    assert.equal(saved.activeTagKey, "Active");
    assert.equal(saved.activeTagValue, "true");
    await h.result.bedrock("unset activeTagKey activeTagValue", h.ctx as never);
    saved = JSON.parse(readFileSync(join(h.root, "bedrock.json"), "utf8"));
    assert.equal("activeTagKey" in saved, false);
    assert.equal("activeTagValue" in saved, false);
});

function withUi(h: ReturnType<typeof harness>, selects: string[], inputs: string[] = []) {
    let selectCalls = 0;
    h.ctx.ui.select = async (_title: string, options: string[] = []) => {
        selectCalls++;
        const wanted = selects.shift();
        if (wanted === undefined) return undefined;
        return options.find((option) => option === wanted || option.startsWith(`${wanted}:`)) ?? wanted;
    };
    h.ctx.ui.input = async () => inputs.shift();
    return () => selectCalls;
}

test("/bedrock alone opens the action menu", async (t) => {
    const h = harness(t, {});
    const calls = withUi(h, ["Help"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(calls(), 1);
});

test("the settings menu edits a tag pair in one step", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings", "activeTagKey", "Set"], ["Active true"]);
    await h.result.bedrock("", h.ctx as never);
    const saved = JSON.parse(readFileSync(join(h.root, "bedrock.json"), "utf8"));
    assert.equal(saved.activeTagKey, "Active");
    assert.equal(saved.activeTagValue, "true");
});

test("the settings menu saves a fixed choice and a comma-separated list", async (t) => {
    const api = harness(t, {});
    withUi(api, ["Settings", "api", "Set", "converse"]);
    await api.result.bedrock("", api.ctx as never);
    assert.equal(JSON.parse(readFileSync(join(api.root, "bedrock.json"), "utf8")).api, "converse");
    const regions = harness(t, {});
    withUi(regions, ["Settings", "regions", "Set"], ["us-east-1,us-west-2"]);
    await regions.result.bedrock("", regions.ctx as never);
    assert.deepEqual(JSON.parse(readFileSync(join(regions.root, "bedrock.json"), "utf8")).regions, [
        "us-east-1",
        "us-west-2",
    ]);
});

test("the settings menu refuses an invalid value and writes nothing", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings", "regions", "Set"], ["nowhere-1"]);
    await h.result.bedrock("", h.ctx as never);
    assert.match(h.notices.join("\n"), /regions must contain 1-16 unique AWS region names/);
    assert.equal(existsSync(join(h.root, "bedrock.json")), false);
});

test("the settings menu unsets both halves of a pair", async (t) => {
    const h = harness(t, {});
    writeFileSync(join(h.root, "bedrock.json"), JSON.stringify({ activeTagKey: "Active", activeTagValue: "true" }));
    withUi(h, ["Settings", "activeTagKey", "Unset"]);
    await h.result.bedrock("", h.ctx as never);
    const saved = JSON.parse(readFileSync(join(h.root, "bedrock.json"), "utf8"));
    assert.equal("activeTagKey" in saved, false);
    assert.equal("activeTagValue" in saved, false);
});

test("the settings menu Escape writes nothing", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(existsSync(join(h.root, "bedrock.json")), false);
});
test("the presets menu lists presets and switches", async (t) => {
    let used = "";
    const h = harness(
        t,
        {},
        {
            presetList: () => [{ name: "dev", profile: "dev", mode: "AWS-defined", active: false }],
            usePreset: async (name: string) => {
                used = name;
            },
        },
    );
    withUi(h, ["Presets", "dev — dev"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(used, "dev");
});

test("the spend and budget menus ask before running", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Budget"], ["250"]);
    await h.result.bedrock("", h.ctx as never);
    assert.match(h.notices.at(-1) ?? "", /Budget set to \$250/);
    withUi(h, ["Spend"], []);
    const calls = h.ctx.ui.select as (...args: never[]) => Promise<string | undefined>;
    assert.ok(calls);
});

test("an explicit refresh reports how many refused models came back", async (t) => {
    const h = harness(t, {}, { clearRefusals: () => 3 });
    await h.result.bedrock("refresh", h.ctx as never);
    assert.match(h.notices.at(-1) ?? "", /3 refused models offered again/);
});
