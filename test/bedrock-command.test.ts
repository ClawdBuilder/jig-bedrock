/* biome-ignore-all lint/suspicious/noExplicitAny: test UI doubles */
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
        model: undefined,
        modelRegistry: { find: (_provider: string, id: string) => ({ ...model, id }) },
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s" },
    };
    pi.setModel = async (selected: any) => {
        ctx.model = selected;
        return true;
    };
    return { root, settings, notices, commands, result, ctx, pi };
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

test("status counts no models as a problem and tells the config fact from a signed-in answer", async (t) => {
    const empty = harness(t, {}, { models: () => [] });
    await empty.result.bedrock("status", empty.ctx as never);
    const none = empty.notices.at(-1) ?? "";
    assert.match(none, /^Bedrock · 1 problem$/m, none);
    assert.match(none, /✗ Models: not loaded/, none);
    assert.match(none, /Next: \/bedrock refresh/, none);
    const config = harness(t, {});
    await config.result.bedrock("status", config.ctx as never);
    const row = config.notices.at(-1) ?? "";
    assert.match(row, /AWS profile: fixture · in the AWS config/, row);
    assert.doesNotMatch(row, /signed in/, row);
    const signed = harness(t, {}, { signedIn: () => true });
    await signed.result.bedrock("status", signed.ctx as never);
    assert.match(signed.notices.at(-1) ?? "", /AWS profile: fixture · signed in/);
});

test("refresh and status name the models this Pi cannot use", async (t) => {
    const rejected = [1, 2, 3].map((number) => ({
        profile: `orders-${number}`,
        region: "us-east-1",
        reason: "Pi registry has no exact metadata for anthropic.claude-opus-6; update Pi to use this profile.",
    }));
    const h = harness(t, {}, { unavailable: () => rejected });
    await h.result.bedrock("refresh", h.ctx as never);
    assert.match(
        h.notices.at(-1) ?? "",
        /3 more are not usable by this Pi: \/bedrock models lists them\./,
        h.notices.at(-1),
    );
    h.notices.length = 0;
    await h.result.bedrock("status", h.ctx as never);
    assert.match(h.notices.at(-1) ?? "", /3 more are not usable by this Pi/, h.notices.at(-1));
});

test("an empty model list gives the Next that fits the catalog status", async (t) => {
    const ok = harness(t, {}, { models: () => [] });
    await ok.result.bedrock("models", ok.ctx as never);
    const fine = ok.notices.at(-1) ?? "";
    assert.match(fine, /No models loaded\./, fine);
    assert.match(fine, /Next: \/bedrock refresh\./, fine);
    const denied = harness(
        t,
        {},
        { models: () => [], discoveryStatus: () => "permission_denied", discoveryMode: () => "tag" },
    );
    await denied.result.bedrock("models", denied.ctx as never);
    assert.match(
        denied.notices.at(-1) ?? "",
        /Next: Ask your AWS administrator for tag:GetResources/,
        denied.notices.at(-1),
    );
});

test("a model this Pi does not know says to update Pi", async (t) => {
    const h = harness(
        t,
        {},
        {
            unavailable: () => [
                {
                    profile: "orders-api",
                    region: "us-east-1",
                    reason: "Pi registry has no exact metadata for anthropic.claude-opus-6; update Pi to use this profile.",
                },
            ],
        },
    );
    await h.result.bedrock("models", h.ctx as never);
    assert.match(h.notices.at(-1) ?? "", /This Pi does not know the model: orders-api, us-east-1 · update Pi/);
});

test("a settings change counts new and gone against the list before it", async (t) => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ ...model, id: `claude-model-${index + 1}` }));
    const thirteen = [
        ...eight,
        ...Array.from({ length: 5 }, (_, index) => ({ ...model, id: `claude-extra-${index + 1}` })),
    ];
    let current = eight;
    const h = harness(
        t,
        {},
        {
            models: () => current,
            // apply() empties the list for the new scope; discovery then finds thirteen.
            apply: () => {
                current = [];
            },
            refresh: async () => {
                current = thirteen;
                return "ok";
            },
        },
    );
    await h.result.bedrock("unset activeTagKey activeTagValue", h.ctx as never);
    assert.match(h.notices.join("\n"), /13 models loaded \(5 new, 0 gone\)/, h.notices.join("\n"));
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
            "✓ AWS profile: fixture · in the AWS config",
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
    assert.match(withProfile.notices.join("\n"), /AWS SSO recovery did not complete/);
    assert.doesNotMatch(withProfile.notices.join("\n"), /aws sso login --profile fixture/);

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
    assert.match(text, /No AWS profile is chosen/);
    assert.match(text, /Next: \/login and choose Amazon Bedrock/);
    assert.doesNotMatch(text, /my-profile/);
    assert.doesNotMatch(text, /aws sso login --profile fixture/);
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

function withUi(h: ReturnType<typeof harness>, selects: string[], inputs: string[] = [], confirms: boolean[] = []) {
    let selectCalls = 0;
    h.ctx.mode = "tui";
    h.ctx.ui.confirm = async () => confirms.shift() ?? true;
    (h.ctx.ui as any).calls = [];
    h.ctx.ui.select = async (title: string, options: string[] = []) => {
        selectCalls++;
        (h.ctx.ui as any).calls.push({ title, options });
        const wanted = selects.shift();
        if (wanted === undefined) return undefined;
        return options.find((option) => option === wanted || option.startsWith(wanted)) ?? wanted;
    };
    h.ctx.ui.input = async (title: string) => {
        (h.ctx.ui as any).calls.push({ title, options: [] });
        return inputs.shift();
    };
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
    withUi(h, ["Settings", "Second tag", "Set"], ["Active true"]);
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

test("the settings menu offers the discovery mode as a choice", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings", "discovery", "Set", "aws-defined"]);
    await h.result.bedrock("", h.ctx as never);
    const saved = JSON.parse(readFileSync(join(h.root, "bedrock.json"), "utf8"));
    assert.equal(saved.discovery, "aws-defined");
});

test("/bedrock settings shows the discovery mode and its source", async (t) => {
    const h = harness(t, {}, { config: { ...config, discovery: "aws-defined" } });
    writeFileSync(join(h.root, "bedrock.json"), JSON.stringify({ discovery: "aws-defined" }));
    await h.result.bedrock("settings", h.ctx as never);
    assert.match(h.notices.join("\n"), /discovery: aws-defined \(file\)/);
});

test("the settings menu refuses an invalid value and writes nothing", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings", "regions", "Set"], ["nowhere-1"]);
    await h.result.bedrock("", h.ctx as never);
    assert.match(h.notices.join("\n"), /nowhere-1 is not an AWS region/);
    assert.equal(existsSync(join(h.root, "bedrock.json")), false);
});

test("the settings menu unsets both halves of a pair", async (t) => {
    const h = harness(t, {});
    writeFileSync(join(h.root, "bedrock.json"), JSON.stringify({ activeTagKey: "Active", activeTagValue: "true" }));
    withUi(h, ["Settings", "Second tag", "Unset"]);
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

test("the presets menu switches to the chosen preset", async (t) => {
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
    withUi(h, ["Presets", "dev"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(used, "dev");
});

test("the presets menu saves a valid name and refuses an invalid one", async (t) => {
    let saved = "";
    const h = harness(
        t,
        {},
        {
            presetAdd: async (name: string) => {
                saved = name;
            },
        },
    );
    withUi(h, ["Presets", "Save current"], ["work"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(saved, "work");
    const bad = harness(
        t,
        {},
        {
            presetAdd: async (name: string) => {
                saved = name;
            },
        },
    );
    saved = "";
    withUi(bad, ["Presets", "Save current"], ["bad name"]);
    await bad.result.bedrock("", bad.ctx as never);
    assert.equal(saved, "");
    assert.match(bad.notices.join("\n"), /not a preset name/);
});

test("the presets menu starts the guided new preset", async (t) => {
    let started = 0;
    const h = harness(t, {}, { presetNew: async () => void started++ });
    withUi(h, ["Presets", "New preset"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(started, 1);
});

test("preset new without a UI points at preset add and the file", async (t) => {
    const h = harness(t, {});
    h.ctx.hasUI = false;
    h.ctx.mode = "rpc";
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    try {
        await h.result.bedrock("preset new", h.ctx as never);
    } finally {
        process.stdout.write = original;
    }
    assert.match(writes.join(""), /\/bedrock preset add/);
    assert.match(writes.join(""), /bedrock\.json/);
});

test("the presets menu removes a preset after confirmation", async (t) => {
    let removed = "";
    const h = harness(
        t,
        {},
        {
            presetList: () => [{ name: "dev", profile: "dev", mode: "AWS-defined", active: false }],
            presetRemove: async (name: string) => {
                removed = name;
            },
        },
    );
    withUi(h, ["Presets", "Remove", "dev"], [], [true]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(removed, "dev");
});

test("the presets menu Escape writes and switches nothing", async (t) => {
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
    withUi(h, []);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(used, "");
});

test("the presets menu says there are no presets and offers only what makes sense", async (t) => {
    const h = harness(t, {}, { presetList: () => [] });
    withUi(h, ["Presets"]);
    await h.result.bedrock("", h.ctx as never);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string; options: string[] }>;
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.title, /No presets yet\. Save the current settings as one first\./);
    assert.deepEqual(calls[1]!.options, ["New preset…", "Save current settings as a preset…", "Back"]);
});

test("Back returns to the menu above, and Escape closes everything", async (t) => {
    const back = harness(
        t,
        {},
        { presetList: () => [{ name: "dev", profile: "dev", mode: "AWS-defined", active: false }] },
    );
    withUi(back, ["Presets", "Back"]);
    await back.result.bedrock("", back.ctx as never);
    const titles = ((back.ctx.ui as any).calls as Array<{ title: string }>).map((call) => call.title);
    assert.deepEqual(titles, ["Bedrock", "Bedrock presets", "Bedrock"]);
    const esc = harness(
        t,
        {},
        { presetList: () => [{ name: "dev", profile: "dev", mode: "AWS-defined", active: false }] },
    );
    withUi(esc, ["Presets"]);
    await esc.result.bedrock("", esc.ctx as never);
    const closed = ((esc.ctx.ui as any).calls as Array<{ title: string }>).map((call) => call.title);
    assert.deepEqual(closed, ["Bedrock", "Bedrock presets"]);
});

test("a preset named Back can be switched to and removed", async (t) => {
    let used = "";
    const h = harness(
        t,
        {},
        {
            presetList: () => [{ name: "Back", profile: "keys", mode: "by tag", active: false }],
            usePreset: async (name: string) => {
                used = name;
            },
        },
    );
    withUi(h, ["Presets", "Back — keys"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(used, "Back");
    let removed = "";
    const r = harness(
        t,
        {},
        {
            presetList: () => [{ name: "Back", profile: "keys", mode: "by tag", active: false }],
            presetRemove: async (name: string) => {
                removed = name;
            },
        },
    );
    withUi(r, ["Presets", "Remove", "Back — remove"], [], [true]);
    await r.result.bedrock("", r.ctx as never);
    assert.equal(removed, "Back");
});

test("the models menu lists registered order, shows details, and uses a model", async (t) => {
    const first = { ...model, id: "claude-sonnet-5-5" };
    const second = { ...model, id: "claude-opus-5" };
    const h = harness(t, {}, { models: () => [first, second] });
    (h.ctx.modelRegistry as any).find = (_p: string, id: string) => ({ ...first, id });
    withUi(h, ["Models", "claude-sonnet-5-5", "Use for this session"]);
    await h.result.bedrock("", h.ctx as never);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string; options: string[] }>;
    assert.deepEqual(
        calls[1]?.options.slice(0, 2).map((option) => option.split(" — ")[0]),
        ["claude-sonnet-5-5", "claude-opus-5"],
    );
    assert.match(calls[2]?.title ?? "", /Converse route/);
    assert.match(calls[2]?.title ?? "", /Region: us-east-1/);
    assert.match(calls[2]?.title ?? "", /Inference profile:/);
    assert.equal(h.ctx.model?.id, "claude-sonnet-5-5");
});

test("the models menu shows refused models and Try again clears them", async (t) => {
    let clears = 0;
    const h = harness(
        t,
        {},
        {
            refused: () => [{ arn: "arn", id: "claude-opus-5", date: "2026-11-16T10:00:00.000Z" }],
            clearRefusals: () => {
                clears++;
                return 1;
            },
        },
    );
    withUi(h, ["Models", "claude-opus-5", "Try again"]);
    await h.result.bedrock("", h.ctx as never);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string; options: string[] }>;
    assert.ok(calls[1]?.options.includes("Refused by AWS for your role"));
    assert.ok(calls[1]?.options.some((option) => option.startsWith("claude-opus-5 · 2026-11-16")));
    assert.equal(clears, 1);
});

test("the models menu lists the models this Pi rejected, with the reason", async (t) => {
    const reason = "Pi registry has no exact metadata for anthropic.claude-opus-6; update Pi to use this profile.";
    const h = harness(
        t,
        {},
        {
            models: () => [],
            unavailable: () => [{ profile: "orders-api", region: "us-east-1", reason }],
        },
    );
    withUi(h, ["Models", "orders-api", "Back"]);
    await h.result.bedrock("", h.ctx as never);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string; options: string[] }>;
    assert.ok(calls[1], "the models menu opened");
    assert.ok(calls[1]!.options.includes("Not loaded by this Pi"), JSON.stringify(calls[1]!.options));
    const row = calls[1]!.options.find((option) => option.includes("orders-api"));
    assert.ok(row, JSON.stringify(calls[1]!.options));
    assert.match(row, /us-east-1/);
    assert.match(row, /Pi registry has no exact metadata for anthropic\.claude-opus-6/);
    assert.match(calls[2]?.title ?? "", /Pi registry has no exact metadata for anthropic\.claude-opus-6/);
    assert.match(calls[2]?.title ?? "", /update Pi to use this profile/);
});

test("the models menu says price unknown instead of $0/$0", async (t) => {
    const unpriced = { ...model, rateSource: "no price", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const h = harness(t, {}, { models: () => [unpriced] });
    withUi(h, ["Models", "claude-sonnet-5-5"]);
    await h.result.bedrock("", h.ctx as never);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string; options: string[] }>;
    const row = calls[1]?.options.find((option) => option.startsWith("claude-sonnet-5-5"));
    assert.ok(row, JSON.stringify(calls[1]?.options));
    assert.match(row, /price unknown/);
    assert.doesNotMatch(row, /\$0\/\$0/);
    assert.match(calls[2]?.title ?? "", /price unknown/);
    assert.doesNotMatch(calls[2]?.title ?? "", /\$0 in/);
});

test("the models menu confirms a session switch, or says why not", async (t) => {
    const h = harness(t, {}, { models: () => [model] });
    (h.ctx.modelRegistry as any).find = (_p: string, id: string) => ({ ...model, id });
    withUi(h, ["Models", "claude-sonnet-5-5", "Use for this session"]);
    await h.result.bedrock("", h.ctx as never);
    assert.match(h.notices.join("\n"), /Using claude-sonnet-5-5 for this session\./);
    assert.equal(h.ctx.model?.id, "claude-sonnet-5-5");
    const refused = harness(t, {}, { models: () => [model] });
    (refused.ctx.modelRegistry as any).find = (_p: string, id: string) => ({ ...model, id });
    refused.pi.setModel = async () => false;
    withUi(refused, ["Models", "claude-sonnet-5-5", "Use for this session"]);
    await refused.result.bedrock("", refused.ctx as never);
    assert.match(refused.notices.join("\n"), /Pi did not switch to claude-sonnet-5-5/);
    assert.doesNotMatch(refused.notices.join("\n"), /Using claude-sonnet-5-5 for this session/);
});

test("the models menu Escape does nothing", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Models"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(h.ctx.model, undefined);
    assert.deepEqual(h.notices, []);
});

test("the main menu offers every action and Escape closes", async (t) => {
    const h = harness(t, {});
    withUi(h, []);
    await h.result.bedrock("", h.ctx as never);
    const options = (h.ctx.ui as any).calls[0].options as string[];
    assert.deepEqual(
        options.map((option) => option.split(" — ")[0]),
        [
            "Status",
            "Check setup",
            "Test one request",
            "Models",
            "Refresh models",
            "Sign in again",
            "Presets",
            "Settings",
            "Spend",
            "Budget",
            "Help",
        ],
    );
    assert.deepEqual(h.notices, []);
});

test("each main-menu action reaches its command", async (t) => {
    const cases: Array<[string, string[], string]> = [
        ["Status", ["Status"], /Bedrock ·/],
        ["Check setup", ["Check setup"], /Bedrock doctor/],
        ["Test one request", ["Test one request"], /tiny request/],
        ["Refresh models", ["Refresh models"], /Bedrock refresh/],
        ["Sign in again", ["Sign in again"], /Bedrock login/],
        ["Help", ["Help"], /Bedrock commands/],
    ];
    for (const [, selects, expected] of cases) {
        const h = harness(t, {});
        withUi(h, selects);
        await h.result.bedrock("", h.ctx as never);
        assert.match(h.notices.join("\n"), expected, selects[0]);
    }
    for (const [label, nested] of [
        ["Models", "Back"],
        ["Presets", "Back"],
        ["Settings", "Back"],
        ["Spend", "Back"],
    ] as const) {
        const h = harness(t, {});
        withUi(h, [label, nested]);
        await h.result.bedrock("", h.ctx as never);
        assert.ok(((h.ctx.ui as any).calls as unknown[]).length >= 2, label);
    }
});

test("Spend asks for a period and shows the existing report", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Spend", "Week"]);
    await h.result.bedrock("", h.ctx as never);
    assert.match(h.notices.join("\n"), /last 7 days/);
});

test("Budget sets, clears, rejects an invalid value and does nothing on empty", async (t) => {
    const set = harness(t, {});
    withUi(set, ["Budget"], ["250"]);
    await set.result.bedrock("", set.ctx as never);
    assert.match(set.notices.at(-1) ?? "", /Budget set to \$250/);
    const clear = harness(t, {});
    withUi(clear, ["Budget"], ["0"]);
    await clear.result.bedrock("", clear.ctx as never);
    assert.match(clear.notices.at(-1) ?? "", /Budget removed/);
    const bad = harness(t, {});
    withUi(bad, ["Budget"], ["nope"]);
    await bad.result.bedrock("", bad.ctx as never);
    assert.match(bad.notices.at(-1) ?? "", /at least \$1/);
    const empty = harness(t, {});
    withUi(empty, ["Budget"], [""]);
    await empty.result.bedrock("", empty.ctx as never);
    assert.deepEqual(empty.notices, []);
});

test("typed commands and no-UI mode do not open a menu", async (t) => {
    const h = harness(t, {});
    let selects = 0;
    h.ctx.mode = "json";
    h.ctx.hasUI = false;
    h.ctx.ui.select = async () => {
        selects++;
        return undefined;
    };
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    try {
        for (const args of ["status", "help", "models", "usage month", "budget 200", "settings"]) {
            await h.result.bedrock(args, h.ctx as never);
        }
    } finally {
        process.stdout.write = original;
    }
    assert.equal(selects, 0);
    const text = writes.join("");
    for (const expected of [
        "Bedrock commands",
        "Bedrock models",
        "Bedrock spend",
        "Bedrock budget",
        "Bedrock settings",
    ]) {
        assert.match(text, new RegExp(expected), expected);
    }
});

test("/bedrock login prints the recovery hint for a browser failure", async (t) => {
    const { SsoRecoveryError } = await import("../src/sso.ts");
    const h = harness(
        t,
        {},
        {
            login: async () => {
                throw new SsoRecoveryError("browser");
            },
        },
    );
    await h.result.bedrock("login", h.ctx as never);
    const text = h.notices.join("\n");
    assert.match(text, /browser opener/);
    assert.doesNotMatch(text, /aws sso login --profile/);
});

test("the presets menu picks dev-eks, not the dev prefix", async (t) => {
    let used = "";
    const h = harness(
        t,
        {},
        {
            presetList: () => [
                { name: "dev", profile: "dev", mode: "AWS-defined", active: false },
                { name: "dev-eks", profile: "dev-eks", mode: "AWS-defined", active: false },
            ],
            usePreset: async (name: string) => {
                used = name;
            },
        },
    );
    withUi(h, ["Presets", "dev-eks"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(used, "dev-eks");
});

test("the models menu picks a model id that shares a prefix", async (t) => {
    const a = { ...model, id: "claude-sonnet" };
    const b = { ...model, id: "claude-sonnet-5-5" };
    const h = harness(t, {}, { models: () => [a, b] });
    withUi(h, ["Models", "claude-sonnet-5-5", "Back"]);
    await h.result.bedrock("", h.ctx as never);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string }>;
    assert.match(calls[2]?.title ?? "", /^claude-sonnet-5-5/);
});

test("the settings list shows pairs once in plain words and inputs carry their hint", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings", "Tag", "Set"], ["Team fixture-team"]);
    await h.result.bedrock("", h.ctx as never);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string; options: string[] }>;
    const settingsOptions = calls.flatMap((call) => call.options);
    assert.ok(
        settingsOptions.some((option) => option.startsWith("Tag:")),
        JSON.stringify(settingsOptions),
    );
    assert.equal(
        settingsOptions.some((option) => option.startsWith("tagValue:")),
        false,
    );
    assert.ok(calls.some((call) => /e\.g\. Team my-team/.test(call.title) && /empty cancels/.test(call.title)));
});

test("a menu save that changes discovery refreshes and does not claim the model left", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings", "Tag", "Set"], ["Team fixture-team"]);
    await h.result.bedrock("", h.ctx as never);
    const text = h.notices.join("\n");
    assert.match(text, /Saved\. Loading models for the new settings/);
    assert.match(text, /Bedrock refresh/);
    assert.doesNotMatch(text, /no longer in your account/);
});

test("the budget input title shows the current value, example and clear rule", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Budget"], [""]);
    await h.result.bedrock("", h.ctx as never);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string }>;
    const title = calls.find((call) => /Monthly budget/.test(call.title))?.title ?? "";
    assert.match(title, /now: (\$100|none)/, JSON.stringify(calls));
    assert.match(title, /e\.g\. 200/);
    assert.match(title, /0 or off clears/);
});

test("a typed discovery change refreshes, and api does not", async (t) => {
    let refreshes = 0;
    const regions = harness(
        t,
        {},
        {
            refresh: async () => {
                refreshes++;
                return "ok";
            },
        },
    );
    await regions.result.bedrock("set regions us-west-2", regions.ctx as never);
    assert.equal(refreshes, 1);
    assert.match(regions.notices.join("\n"), /Saved\. Loading models for the new settings/);
    const api = harness(
        t,
        {},
        {
            refresh: async () => {
                refreshes++;
                return "ok";
            },
        },
    );
    refreshes = 0;
    await api.result.bedrock("set api converse", api.ctx as never);
    assert.equal(refreshes, 0);
});

test("an invalid menu value reopens the input, then a valid one saves once", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings", "regions", "Set"], ["nowhere-1", "us-east-1"]);
    await h.result.bedrock("", h.ctx as never);
    const saved = JSON.parse(readFileSync(join(h.root, "bedrock.json"), "utf8"));
    assert.deepEqual(saved.regions, ["us-east-1"]);
    const calls = (h.ctx.ui as any).calls as Array<{ title: string }>;
    assert.ok(calls.some((call) => /value not accepted/.test(call.title)));
});

test("an invalid menu value followed by Escape writes nothing", async (t) => {
    const h = harness(t, {});
    withUi(h, ["Settings", "regions", "Set"], ["nowhere-1"]);
    await h.result.bedrock("", h.ctx as never);
    assert.equal(existsSync(join(h.root, "bedrock.json")), false);
});

test("broken settings repair writes typed multi-key values", async (t) => {
    const h = harness(t, {});
    const file = join(h.root, "bedrock.json");
    writeFileSync(file, JSON.stringify({ regions: [] }));
    const handler = registerBrokenCommands({ registerCommand() {} } as never, {
        file,
        error: "regions must contain 1-16 unique AWS region names.",
        env: h.settings,
    });
    await handler("set tagKey Team tagValue fixture-team", h.ctx as never);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.tagKey, "Team");
    assert.equal(saved.tagValue, "fixture-team");
    await handler("set converseModels claude-opus-5,claude-sonnet-5-5", h.ctx as never);
    const list = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(list.converseModels, ["claude-opus-5", "claude-sonnet-5-5"]);
});

test("broken settings repair refuses an unclear boolean without writing", async (t) => {
    const h = harness(t, {});
    const file = join(h.root, "bedrock.json");
    writeFileSync(file, JSON.stringify({ regions: [] }));
    const before = readFileSync(file, "utf8");
    const handler = registerBrokenCommands({ registerCommand() {} } as never, {
        file,
        error: "regions must contain 1-16 unique AWS region names.",
        env: h.settings,
    });
    await handler("set debug maybe", h.ctx as never);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.match(h.notices.at(-1) ?? "", /accepts true, false, on, off, yes or no; nothing was written/);
});

test("login with no profile says exactly what to run, without a doctor loop", async (t) => {
    const h = harness(
        t,
        {},
        {
            login: async () => {
                throw new Error("No AWS profile is chosen. Run /login first.");
            },
        },
    );
    await h.result.bedrock("login", h.ctx as never);
    const text = h.notices.join("\n");
    assert.match(text, /No AWS profile is chosen/);
    assert.match(text, /Next: \/login and choose Amazon Bedrock \(jig-bedrock\)\./);
    assert.doesNotMatch(text, /\/bedrock doctor/);
});

test("status says how to stop using the saved profile after a real /logout", async (t) => {
    const h = harness(t, {}, { storedAuthLost: () => true });
    await h.result.bedrock("status", h.ctx as never);
    assert.match(h.notices.join("\n"), /\/bedrock unset profile/);
});

test("the /logout note appears only when a stored credential was lost in this session", async (t) => {
    const kept = harness(t, {}, { storedAuthLost: () => false });
    await kept.result.bedrock("status", kept.ctx as never);
    assert.doesNotMatch(kept.notices.join("\n"), /\/bedrock unset profile/);
    const lost = harness(t, {}, { storedAuthLost: () => true });
    await lost.result.bedrock("status", lost.ctx as never);
    assert.match(lost.notices.join("\n"), /\/bedrock unset profile/);
});
