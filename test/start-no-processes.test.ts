// Starting Pi with this package starts no child process of its own: AWS profile names come from the AWS files, not from the
// AWS CLI (whose start takes over a second, and which Pi's provider checks ask for several times at once). A fake `aws`
// first on the PATH writes a marker line for every run, so a test sees any program that was started.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicCache } from "../src/cache.ts";
import { filterHash } from "../src/catalog.ts";
import { jigBedrock } from "../src/index.ts";

type Hook = (...args: unknown[]) => unknown;

const ARN = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-v1:0";

interface Machine {
    dir: string;
    /** One line per run of the fake `aws`; the file does not exist when it never ran. */
    marker: string;
    env: NodeJS.ProcessEnv;
}

/** A temporary machine: its own home, AWS files and a fake `aws` first on the PATH. Restored when the test ends. */
function machine(t: test.TestContext, files: { config?: string; credentials?: string; settings?: object }): Machine {
    const dir = mkdtempSync(join(tmpdir(), "jig-bedrock-start-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "agent"));
    const marker = join(dir, "aws-ran");
    writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "$*" >> "${marker}"\nexit 1\n`);
    chmodSync(join(bin, "aws"), 0o755);
    writeFileSync(join(dir, "config"), files.config ?? "");
    writeFileSync(join(dir, "credentials"), files.credentials ?? "");
    if (files.settings !== undefined) writeFileSync(join(dir, "agent", "bedrock.json"), JSON.stringify(files.settings));
    const keys = [
        "HOME",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
    ];
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
        rmSync(dir, { recursive: true, force: true });
    });
    Object.assign(process.env, {
        HOME: dir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: join(dir, "agent"),
        AWS_CONFIG_FILE: join(dir, "config"),
        AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
    });
    delete process.env.XDG_CACHE_HOME;
    process.env.XDG_STATE_HOME = join(dir, "state");
    return { dir, marker, env: { ...process.env } };
}

/** Loads the extension as Pi does and fires every session_start hook; returns when the hooks have returned. */
async function start(m: Machine): Promise<{
    sessionStartMs: number;
    providers: Array<{
        id?: string;
        refreshModels?: (context: {
            allowNetwork: boolean;
            force?: boolean;
            signal: AbortSignal;
            publish: (value: { update: () => void }) => Promise<boolean>;
        }) => Promise<void>;
    }>;
}> {
    const hooks = new Map<string, Hook[]>();
    const providers: Array<{
        id?: string;
        refreshModels?: (context: {
            allowNetwork: boolean;
            force?: boolean;
            signal: AbortSignal;
            publish: (value: { update: () => void }) => Promise<boolean>;
        }) => Promise<void>;
    }> = [];
    const pi = {
        on(name: string, hook: Hook) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: {
            id?: string;
            refreshModels?: (context: {
                allowNetwork: boolean;
                force?: boolean;
                signal: AbortSignal;
                publish: (value: { update: () => void }) => Promise<boolean>;
            }) => Promise<void>;
        }) {
            providers.push(provider);
        },
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    await (jigBedrock({ env: m.env }) as never as (pi: unknown) => Promise<void>)(pi);
    const ctx = {
        hasUI: true,
        mode: "tui",
        ui: { notify() {}, setStatus() {} },
        sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionDir: () => m.dir },
    };
    const began = performance.now();
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    return { sessionStartMs: performance.now() - began, providers };
}

/** Long enough for the background work a session start begins (the sign-in check waits one turn of the event loop). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

function writeCache(m: Machine, profile: string): void {
    atomicCache(join(m.dir, ".cache", "jig-bedrock", "catalog.json"), {
        schema: 1,
        mode: "system",
        aws_profile: profile,
        account_id: "123456789012",
        regions: ["us-east-1"],
        fetched_at: Math.floor(Date.now() / 1000),
        filter_hash: filterHash({ mode: "system" }),
        profiles: [
            {
                arn: ARN,
                profile_name: "Haiku",
                foundation_model_id: "anthropic.claude-haiku-4-5",
                region: "us-east-1",
                kind: "system",
            },
        ],
    });
}

const KEYS = "[profile work]\nregion = us-east-1\n";
const KEY_FILE = "[work]\naws_access_key_id = AKIAFIXTURE\naws_secret_access_key = secret-canary\n";

test("no settings and no profile: no program starts", async (t) => {
    const m = machine(t, {});
    await start(m);
    await settle();
    assert.equal(existsSync(m.marker), false, "the AWS CLI was started");
});

test("a profile in bedrock.json is looked up in the AWS files, never with `aws configure list-profiles`", async (t) => {
    const m = machine(t, { config: KEYS, credentials: KEY_FILE, settings: { profile: "work" } });
    await start(m);
    await settle();
    // Without a fresh catalog the background discovery asks AWS who the caller is; that is its job and the only run.
    const runs = existsSync(m.marker) ? readFileSync(m.marker, "utf8").trim().split("\n") : [];
    assert.deepEqual(
        runs.filter((line) => !line.startsWith("sts get-caller-identity --profile work")),
        [],
        `unexpected runs: ${runs.join(" | ")}`,
    );
});

test("a profile and a fresh catalog cache: no program starts", async (t) => {
    const m = machine(t, { config: KEYS, credentials: KEY_FILE, settings: { profile: "work" } });
    writeCache(m, "work");
    await start(m);
    await settle();
    assert.equal(existsSync(m.marker), false, "the AWS CLI was started");
});

test("credentials in the environment: the profile list is never asked for", async (t) => {
    const m = machine(t, {});
    m.env.AWS_ACCESS_KEY_ID = "AKIAFIXTURE";
    m.env.AWS_SECRET_ACCESS_KEY = "secret-canary";
    writeCache(m, "");
    await start(m);
    await settle();
    assert.equal(existsSync(m.marker), false, "the AWS CLI was started");
});

test("a spend command runs after the session has started, and session_start does not wait for it", async (t) => {
    const m = machine(t, { config: KEYS, credentials: KEY_FILE });
    const script = join(m.dir, "spend");
    writeFileSync(script, `#!/bin/sh\necho started >> "${join(m.dir, "spend-ran")}"\nsleep 2\nexit 1\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(m.dir, "agent", "bedrock.json"), JSON.stringify({ profile: "work", spendCommand: [script] }));
    writeCache(m, "work");
    const { sessionStartMs } = await start(m);
    assert.ok(
        sessionStartMs < 1_500,
        `session_start took ${sessionStartMs.toFixed(0)} ms; it must not wait for the spend command`,
    );
    await settle();
    assert.equal(existsSync(join(m.dir, "spend-ran")), true, "the spend command the user set did run");
    assert.equal(existsSync(m.marker), false, "the AWS CLI was started");
});

test("Pi's start-up refresh call with allowNetwork false starts no program", async (t) => {
    const m = machine(t, { config: KEYS, credentials: KEY_FILE, settings: { profile: "work" } });
    writeCache(m, "work");
    const { providers } = await start(m);
    const provider = providers.find((entry) => entry.id === "jig-bedrock");
    assert.ok(provider?.refreshModels, "the provider has refreshModels");
    await provider.refreshModels({
        allowNetwork: false,
        force: true,
        signal: new AbortController().signal,
        publish: async (value) => {
            value.update();
            return true;
        },
    });
    await settle();
    assert.equal(existsSync(m.marker), false, "the AWS CLI was started");
});
