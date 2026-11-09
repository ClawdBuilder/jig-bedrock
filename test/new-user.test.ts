// The findings from running 0.2.2 as a new user: the start-up advice names the missing profile and /login; the doctor
// names the profile, its source, the mode and the regions with markers; and the package ships the docs the README links.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jigBedrock } from "../src/index.ts";

type Hook = (...args: any[]) => any;

/** A Pi stand-in that records hooks, commands and providers. */
function harness() {
    const hooks = new Map<string, Hook[]>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const providers: any[] = [];
    const pi = {
        on(name: string, hook: Hook) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            if (typeof provider !== "string") providers.push(provider);
        },
        registerCommand(name: string, options: any) {
            commands.set(name, options);
        },
        events: { emit() {} },
        setModel: () => false,
    };
    return { pi, hooks, commands, providers };
}

/** Runs every session_start hook in order, as Pi does, and returns the notices. */
async function startWith(options: { env: NodeJS.ProcessEnv; listing?: string[]; dir: string }) {
    const { pi, hooks, commands, providers } = harness();
    const notices: string[] = [];
    await (
        jigBedrock({
            env: options.env,
            listProfiles: async () => options.listing,
            catalog: { load: () => undefined, refresh: async () => "ok" },
        }) as never
    )(pi as never);
    const ctx = {
        ui: { notify: (text: string) => notices.push(text) },
        mode: "print",
        sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionDir: () => options.dir },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    return { notices, commands, providers, pi, hooks };
}

function home(): string {
    return mkdtempSync(join(tmpdir(), "bedrock-new-user-"));
}

test("start-up with no profile names the setting and points to /login", async () => {
    const dir = home();
    try {
        const { notices } = await startWith({ dir, env: { HOME: dir, PI_CODING_AGENT_DIR: dir } });
        const text = notices.join("\n");
        assert.match(text, /No AWS profile is configured for Bedrock/);
        assert.match(text, /\/login/);
        assert.match(text, /bedrock\.profile/);
        assert.doesNotMatch(text, /run \/aws-login/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("start-up with a profile that does not exist says so and does not send you to /aws-login", async () => {
    const dir = home();
    try {
        const { notices } = await startWith({
            dir,
            listing: ["other-profile"],
            env: { HOME: dir, PI_CODING_AGENT_DIR: dir, JIG_BEDROCK_PROFILE: "missing-profile" },
        });
        const text = notices.join("\n");
        assert.match(text, /missing-profile \(from JIG_BEDROCK_PROFILE\) is not in aws configure list-profiles/);
        assert.match(text, /\/login/);
        assert.doesNotMatch(text, /run \/aws-login/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the Bedrock (Jig) /login offers only an AWS profile, never a bearer token", async () => {
    const dir = home();
    try {
        const { providers } = await startWith({ dir, listing: ["work"], env: { HOME: dir, PI_CODING_AGENT_DIR: dir } });
        const provider = providers.find((entry) => entry?.id === "jig-bedrock");
        assert.ok(provider, "the jig-bedrock provider is registered");
        assert.equal(provider.auth.oauth, undefined);
        assert.equal(provider.auth.apiKey.name, "AWS profile");
        assert.doesNotMatch(String(provider.auth.apiKey.login), /bearer/i);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("start-up with a real profile says the models are loading, not that a setting is missing", async () => {
    const dir = home();
    try {
        const { notices } = await startWith({
            dir,
            listing: ["work-profile"],
            env: { HOME: dir, PI_CODING_AGENT_DIR: dir, JIG_BEDROCK_PROFILE: "work-profile" },
        });
        const text = notices.join("\n");
        assert.match(text, /Bedrock models are not loaded yet/);
        assert.doesNotMatch(text, /No AWS profile is configured/);
        assert.doesNotMatch(text, /run \/aws-login/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** The doctor's report text, from the command's notification. */
async function doctor(env: NodeJS.ProcessEnv, listing: string[]): Promise<string> {
    const dir = home();
    try {
        const { commands } = await startWith({ dir, listing, env: { HOME: dir, PI_CODING_AGENT_DIR: dir, ...env } });
        const notices: string[] = [];
        const ctx = { ui: { notify: (text: string) => notices.push(text) }, mode: "print" };
        await commands.get("bedrock-doctor")!.handler("", ctx);
        return notices.join("\n");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("the doctor names the profile, its source, the mode and the regions", async () => {
    const text = await doctor({ JIG_BEDROCK_PROFILE: "work-profile", LANG: "C.UTF-8" }, ["work-profile"]);
    assert.match(text, /✓ Profile: work-profile \(JIG_BEDROCK_PROFILE\)/);
    assert.match(text, /✓ Discovery: system-defined · regions: us-east-1/);
    assert.match(text, /✓ loaded|not loaded/);
    assert.doesNotMatch(text, /Profile configuration: loaded/);
});

test("the doctor fails a missing profile and points at /login", async () => {
    const text = await doctor({ JIG_BEDROCK_PROFILE: "missing-profile", LANG: "C.UTF-8" }, ["other-profile"]);
    assert.match(text, /✗ Profile: missing-profile \(JIG_BEDROCK_PROFILE\) — not in aws configure list-profiles/);
    assert.match(text, /\/login/);
});

test("the doctor says none when no profile is configured", async () => {
    const text = await doctor({ LANG: "C.UTF-8" }, []);
    assert.match(text, /✗ Profile: none — No AWS profile is configured for Bedrock/);
    assert.match(text, /\/login/);
});

test("the doctor uses words when the locale is not UTF-8", async () => {
    const text = await doctor({ JIG_BEDROCK_PROFILE: "missing-profile", LANG: "C" }, ["other-profile"]);
    assert.match(text, /failure Profile: missing-profile/);
    assert.doesNotMatch(text, /✗/);
});

test("the doctor uses words when NO_COLOR is set", async () => {
    const text = await doctor({ JIG_BEDROCK_PROFILE: "missing-profile", LANG: "C.UTF-8", NO_COLOR: "1" }, [
        "other-profile",
    ]);
    assert.match(text, /failure Profile:/);
    assert.doesNotMatch(text, /✗/);
});
