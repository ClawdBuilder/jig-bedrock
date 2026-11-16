// A refusal hides a model until an explicit refresh clears the store; automatic refreshes keep it hidden.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CatalogSource } from "../src/aws-discovery.ts";
import { type Catalog, filterHash } from "../src/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { rememberRefusal } from "../src/refusals.ts";

const region = "us-east-1";
const account = "123456789012";
const arn = `arn:aws:bedrock:${region}:${account}:application-inference-profile/team-opus`;
const catalog: Catalog = {
    schema: 1,
    mode: "tag",
    aws_profile: "fixture",
    account_id: account,
    regions: [region],
    fetched_at: Math.floor(Date.now() / 1000),
    filter_hash: filterHash({ mode: "tag", tagKey: "Team", tagValue: "fixture-team" }),
    profiles: [
        {
            arn,
            profile_name: "team-claude-opus-5",
            foundation_model_id: "anthropic.claude-opus-5",
            region,
            kind: "application",
        },
    ],
};

async function providerWithRefusal() {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-refresh-refusal-"));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CACHE_HOME: join(dir, "cache") };
    writeFileSync(
        join(dir, "bedrock.json"),
        JSON.stringify({ profile: "fixture", tagKey: "Team", tagValue: "fixture-team", regions: [region] }),
    );
    const config = loadConfig({
        raw: { profile: "fixture", tagKey: "Team", tagValue: "fixture-team", regions: [region] },
        env,
        agentDir: dir,
    });
    assert.ok(config.config);
    rememberRefusal(env, "fixture", account, arn, "claude-opus-5");
    const source: CatalogSource = { load: () => catalog, refresh: async () => "ok" };
    const providers: any[] = [];
    const commands = new Map<string, any>();
    const pi = {
        on() {},
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: () => false,
    };
    const handle = await createBedrockProvider({
        env,
        config: config.config,
        catalog: source,
        listProfiles: async () => ["fixture"],
        backgroundRefresh: false,
    })(pi as never);
    assert.ok(handle);
    return { dir, env, providers, commands, handle };
}

const latest = (providers: any[]) => providers.at(-1)?.getModels?.() ?? [];
const notices: string[] = [];
const ctx = {
    hasUI: true,
    mode: "rpc",
    signal: new AbortController().signal,
    ui: { notify: (text: string) => notices.push(text), setStatus() {} },
    sessionManager: { getSessionId: () => "s" },
};

test("an explicit refresh clears the refusal and re-registers the model", async (t) => {
    const s = await providerWithRefusal();
    t.after(() => rmSync(s.dir, { recursive: true, force: true }));
    assert.equal(
        latest(s.providers).some((model: any) => model.id === "claude-opus-5"),
        false,
    );
    notices.length = 0;
    await s.commands.get("bedrock").handler("refresh", ctx);
    assert.equal(
        latest(s.providers).some((model: any) => model.id === "claude-opus-5"),
        true,
    );
    assert.match(notices.join("\n"), /1 refused model offered again/);
});

test("the 24-hour background refresh keeps the refusal hidden", async (t) => {
    const s = await providerWithRefusal();
    t.after(() => rmSync(s.dir, { recursive: true, force: true }));
    await s.handle.refresh(false);
    assert.equal(
        latest(s.providers).some((model: any) => model.id === "claude-opus-5"),
        false,
    );
});

test("Pi's /model refresh keeps the refusal hidden", async (t) => {
    const s = await providerWithRefusal();
    t.after(() => rmSync(s.dir, { recursive: true, force: true }));
    await latest(s.providers).length; // provider exists before its hook
    const provider = s.providers.at(-1);
    assert.ok(provider.refreshModels);
    await provider.refreshModels({
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        publish: async () => true,
    });
    assert.equal(
        latest(s.providers).some((model: any) => model.id === "claude-opus-5"),
        false,
    );
});

test("the doctor fills the model list and does not repeat a stale network next step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-doctor-refresh-"));
    try {
        writeFileSync(join(dir, "bedrock.json"), JSON.stringify({ profile: "fixture", regions: [region] }));
        mkdirSync(join(dir, "bin"), { recursive: true });
        writeFileSync(join(dir, "bin", "aws"), "#!/bin/sh\necho aws-cli/2.34.46\n", { mode: 0o755 });
        const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
        const config = loadConfig({
            raw: { profile: "fixture", regions: [region] },
            env,
            agentDir: dir,
        });
        assert.ok(config.config);
        let current: Catalog | undefined;
        const source: CatalogSource = {
            load: () => current,
            refresh: async () => {
                current = catalog;
                return "ok";
            },
            status: () => undefined,
        };
        const notices: string[] = [];
        const providers: any[] = [];
        const commands = new Map<string, any>();
        const pi = {
            on() {},
            registerProvider(provider: any) {
                providers.push(provider);
            },
            registerCommand(name: string, value: any) {
                commands.set(name, value);
            },
            events: { emit() {} },
            setModel: () => false,
        };
        await createBedrockProvider({
            env,
            config: config.config,
            catalog: source,
            listProfiles: async () => ["fixture"],
            verifyProfile: async () => ({ ok: true }),
            backgroundRefresh: false,
        })(pi as never);
        assert.equal(latest(providers).length, 0);
        await commands.get("bedrock").handler("doctor", {
            hasUI: true,
            mode: "rpc",
            signal: new AbortController().signal,
            ui: { notify: (text: string) => notices.push(text), setStatus() {} },
            sessionManager: { getSessionId: () => "s" },
            modelRegistry: { find: () => undefined },
        });
        assert.equal(
            latest(providers).length,
            1,
            JSON.stringify({ notices, current: current?.profiles?.length, providers: providers.length }),
        );
        assert.match(notices.join("\n"), /Models: 1 found/);
        assert.doesNotMatch(notices.join("\n"), /Check network access/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
