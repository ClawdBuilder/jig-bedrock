import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CatalogSource } from "../src/aws-discovery.ts";
import { type Catalog, filterHash } from "../src/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { createBedrockProvider } from "../src/provider.ts";

function catalogFor(region: string): Catalog {
    return {
        schema: 1,
        mode: "system",
        aws_profile: "fixture",
        account_id: "123456789012",
        regions: [region],
        fetched_at: Math.floor(Date.now() / 1000),
        filter_hash: filterHash({ mode: "system", regions: [region] }),
        profiles: [
            {
                arn: `arn:aws:bedrock:${region}:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5`,
                profile_name: "Sonnet",
                foundation_model_id: "anthropic.claude-sonnet-5-5",
                region,
                kind: "system",
            },
        ],
    };
}

async function start(initial: Record<string, unknown>, envExtra: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-settings-memory-"));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, ...envExtra };
    const raw = { profile: "keys", regions: ["us-east-1"], ...initial };
    writeFileSync(join(dir, "bedrock.json"), JSON.stringify(raw));
    const resolved = loadConfig({ raw, env, agentDir: dir });
    assert.ok(resolved.config);
    let current = catalogFor("us-east-1");
    const source: CatalogSource = {
        load: () => current,
        refresh: async () => {
            current = catalogFor((resolved.config?.regions ?? ["us-east-1"])[0]!);
            return "ok";
        },
        status: () => "ok",
    };
    const signed: string[] = [];
    const notices: string[] = [];
    const commands = new Map<string, any>();
    const providers: any[] = [];
    const pi = {
        on() {},
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async () => true,
    };
    await createBedrockProvider({
        env,
        config: resolved.config,
        catalog: source,
        listProfiles: async () => ["keys", "demo-sso"],
        ssoRecover: async (profile: string) => {
            signed.push(profile);
        },
        verifyProfile: async () => ({ ok: true }),
        backgroundRefresh: false,
    })(pi as never);
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s" },
        modelRegistry: { find: () => undefined },
    };
    return { dir, env, raw, resolved, commands, notices, signed, providers, ctx };
}

test("set profile then login renews the new profile, and status shows it", async (t) => {
    const s = await start({});
    try {
        await s.commands.get("bedrock").handler("set profile demo-sso", s.ctx);
        await s.commands.get("bedrock").handler("login", s.ctx);
        assert.deepEqual(s.signed, ["demo-sso"]);
        await s.commands.get("bedrock").handler("status", s.ctx);
        assert.match(s.notices.join("\n"), /AWS profile: demo-sso/);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("unset profile removes the old profile from login and status", async (t) => {
    const s = await start({});
    try {
        await s.commands.get("bedrock").handler("unset profile", s.ctx);
        await s.commands.get("bedrock").handler("login", s.ctx);
        assert.equal(s.signed.length, 0);
        await s.commands.get("bedrock").handler("status", s.ctx);
        assert.doesNotMatch(s.notices.join("\n"), /AWS profile: keys/);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("a typed regions save registers the new region's models", async (t) => {
    const s = await start({});
    try {
        await s.commands.get("bedrock").handler("set regions us-west-2", s.ctx);
        const models = s.providers.at(-1)?.getModels?.() ?? [];
        assert.ok(
            models.some((model: any) => model.id === "claude-sonnet-5-5"),
            JSON.stringify(models),
        );
        assert.ok(
            models.some((model: any) => String(model.baseUrl).includes("us-west-2")),
            JSON.stringify(models),
        );
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("unset monthlyBudgetUsd removes the budget in memory", async (t) => {
    const s = await start({ monthlyBudgetUsd: 200 });
    try {
        await s.commands.get("bedrock").handler("unset monthlyBudgetUsd", s.ctx);
        await s.commands.get("bedrock").handler("status", s.ctx);
        assert.doesNotMatch(s.notices.join("\n"), /of \$200/);
        assert.doesNotMatch(s.notices.join("\n"), /Budget: \$200/);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("unset spendCommand removes it from the running settings", async (t) => {
    const s = await start({ spendCommand: ["node", "s.mjs"] });
    try {
        await s.commands.get("bedrock").handler("unset spendCommand", s.ctx);
        await s.commands.get("bedrock").handler("doctor offline", s.ctx);
        assert.match(s.notices.join("\n"), /Spend command: not set/);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("a route save re-registers the models with the new route", async (t) => {
    const s = await start({});
    try {
        const id = s.providers.at(-1)?.getModels?.()[0]?.id;
        assert.ok(id);
        await s.commands.get("bedrock").handler(`set converseModels ${id}`, s.ctx);
        assert.equal(s.providers.at(-1)?.getModels?.()[0]?.api, "bedrock-converse-stream");
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("a quoted value with spaces is saved whole", async (t) => {
    const s = await start({});
    try {
        await s.commands.get("bedrock").handler('set tagKey Team tagValue "Team A"', s.ctx);
        const saved = JSON.parse(readFileSync(join(s.dir, "bedrock.json"), "utf8"));
        assert.equal(saved.tagValue, "Team A");
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("booleans accept words and unknown presets are refused without writing", async (t) => {
    const s = await start({});
    try {
        await s.commands.get("bedrock").handler("set debug yes", s.ctx);
        let saved = JSON.parse(readFileSync(join(s.dir, "bedrock.json"), "utf8"));
        assert.equal(saved.debug, true);
        await s.commands.get("bedrock").handler("set preset nosuch", s.ctx);
        saved = JSON.parse(readFileSync(join(s.dir, "bedrock.json"), "utf8"));
        assert.equal(saved.preset, undefined);
        assert.match(s.notices.join("\n"), /Unknown preset nosuch/);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("every settings-menu example is a value its own key accepts", async (t) => {
    const { SETTING_EXAMPLES } = await import("../src/commands.ts");
    for (const [key, example] of Object.entries(SETTING_EXAMPLES)) {
        const s = await start({});
        try {
            await s.commands.get("bedrock").handler(`set ${key} ${example}`, s.ctx);
            const saved = JSON.parse(readFileSync(join(s.dir, "bedrock.json"), "utf8"));
            assert.ok(saved[key] !== undefined, `${key}=${example}: ${s.notices.join("\n")}`);
            assert.doesNotMatch(s.notices.join("\n"), /not accepted|Unknown preset/, key);
        } finally {
            rmSync(s.dir, { recursive: true, force: true });
        }
    }
});

test("a set under an active preset writes into the preset", async (t) => {
    const s = await start({ preset: "work", presets: { work: { profile: "old" } }, regions: ["us-east-1"] });
    try {
        await s.commands.get("bedrock").handler("set regions eu-west-1", s.ctx);
        const saved = JSON.parse(readFileSync(join(s.dir, "bedrock.json"), "utf8"));
        assert.deepEqual(saved.presets.work.regions, ["eu-west-1"]);
        assert.deepEqual(saved.regions, ["us-east-1"]);
        assert.match(s.notices.join("\n"), /saved to preset work/);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("setting a profile that is not in the AWS config shows it in status", async (t) => {
    const s = await start({});
    try {
        await s.commands.get("bedrock").handler("set profile ghost", s.ctx);
        await s.commands.get("bedrock").handler("status", s.ctx);
        assert.match(s.notices.join("\n"), /ghost is not in the AWS config/);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("preset add announces the active preset and reloads models", async (t) => {
    const s = await start({});
    try {
        await s.commands.get("bedrock").handler("preset add extra", s.ctx);
        assert.match(s.notices.join("\n"), /Preset extra saved and active; models reloaded/);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("a preset chosen for the session survives an env preset on the next save", async (t) => {
    const s = await start(
        { preset: "work", presets: { work: { regions: ["us-east-1"] }, personal: { regions: ["us-east-1"] } } },
        { JIG_BEDROCK_PRESET: "work" },
    );
    try {
        await s.commands.get("bedrock").handler("use personal", s.ctx);
        await s.commands.get("bedrock").handler("set regions eu-west-1", s.ctx);
        const saved = JSON.parse(readFileSync(join(s.dir, "bedrock.json"), "utf8"));
        assert.deepEqual(saved.presets.personal.regions, ["eu-west-1"]);
        assert.deepEqual(saved.presets.work.regions, ["us-east-1"]);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});

test("a set overridden by an environment variable says so", async (t) => {
    const s = await start({}, { JIG_BEDROCK_REGIONS: "us-east-1" });
    try {
        await s.commands.get("bedrock").handler("set regions eu-west-1", s.ctx);
        assert.match(s.notices.join("\n"), /JIG_BEDROCK_REGIONS=us-east-1 is in use for this session/);
        const saved = JSON.parse(readFileSync(join(s.dir, "bedrock.json"), "utf8"));
        assert.deepEqual(saved.regions, ["eu-west-1"]);
    } finally {
        rmSync(s.dir, { recursive: true, force: true });
    }
});
