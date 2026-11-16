// Sign-in advice: /bedrock login renews an SSO profile or a role over an SSO source_profile, and the doctor offers it only
// where it can work. A keys profile or a role over keys gets the AWS CLI check from both commands, never /bedrock login,
// so neither command can send a person in a circle.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";

const CONFIG = [
    "[profile keys]",
    "aws_access_key_id = AKIAFIXTURE",
    "aws_secret_access_key = fixture-secret",
    "[profile deploy]",
    "role_arn = arn:aws:iam::123456789012:role/deploy",
    "source_profile = keys",
    "[profile sso]",
    "sso_session = session",
    "[sso-session session]",
    "sso_region = us-east-1",
    "sso_start_url = https://example.awsapps.com/start",
    "[profile role-sso]",
    "role_arn = arn:aws:iam::123456789012:role/role-sso",
    "source_profile = sso",
].join("\n");

const PROFILES = ["keys", "deploy", "sso", "role-sso"];
const KEYS_ADVICE =
    /^Next: check the keys or role for (?:keys|deploy) with "aws sts get-caller-identity --profile (?:keys|deploy)", or refresh the keys, then \/bedrock doctor\.$/;

async function start(t: test.TestContext, profile: string) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-sign-in-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    const bin = join(dir, "bin");
    mkdirSync(agent, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
        join(bin, "aws"),
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "aws-cli/2.34.46 Python/3.12"; exit 0; fi\nexit 1\n',
        { mode: 0o755 },
    );
    writeFileSync(join(dir, "config"), CONFIG);
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify({ profile, regions: ["us-east-1"] }));
    const env = {
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        AWS_CONFIG_FILE: join(dir, "config"),
        XDG_CACHE_HOME: join(dir, "cache"),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        LANG: "C.UTF-8",
    };
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
        on() {},
        registerProvider() {},
        registerCommand(name: string, value: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async () => true,
    };
    await createBedrockProvider({
        env,
        config: {
            profile,
            regions: ["us-east-1"],
            agentDir: agent,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: { load: () => undefined, refresh: async () => "ok", status: () => "ok" } as never,
        listProfiles: async () => PROFILES,
        // A sign-in check that failed for a reason neither expiry nor a permission: the profile type alone decides the
        // next step.
        verifyProfile: async () => ({
            ok: false,
            message: `AWS did not answer for ${profile}. Check the profile and your network access, then try again.`,
        }),
        check: async () => ({
            node: { status: "ready", version: "22.19.0" },
            aws: { status: "ready", version: "2.34.46" },
            platform: "linux",
        }),
        backgroundRefresh: false,
    } as never)(pi as never);
    const notices: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: { find: () => undefined },
    };
    const command = commands.get("bedrock");
    assert.ok(command, "the /bedrock command is registered");
    return { command, ctx, notices };
}

/** The first Next line of a command's notice block. */
function firstNext(text: string): string {
    const next = text.split("\n").filter((line) => line.startsWith("Next: "));
    assert.ok(next.length > 0, text);
    return next[0] ?? "";
}

for (const profile of ["keys", "deploy"] as const) {
    test(`the doctor sends the ${profile} profile to the keys check, not /bedrock login`, async (t) => {
        const s = await start(t, profile);
        await s.command.handler("doctor", s.ctx);
        const text = s.notices.join("\n");
        assert.match(firstNext(text), KEYS_ADVICE, text);
        assert.doesNotMatch(text, /Next: \/bedrock login/, text);
    });
}

for (const profile of ["sso", "role-sso"] as const) {
    test(`the doctor sends the ${profile} profile to /bedrock login`, async (t) => {
        const s = await start(t, profile);
        await s.command.handler("doctor", s.ctx);
        const text = s.notices.join("\n");
        assert.equal(firstNext(text), "Next: /bedrock login", text);
        assert.doesNotMatch(text, /aws sts get-caller-identity/, text);
    });
}

test("a keys profile's /bedrock login gives the keys advice, not the same command again", async (t) => {
    const s = await start(t, "keys");
    await s.command.handler("login", s.ctx);
    const text = s.notices.join("\n");
    assert.match(text, /signs in with its own keys or role/, text);
    assert.match(firstNext(text), KEYS_ADVICE, text);
    assert.doesNotMatch(text, /\/bedrock login/, text);
    assert.doesNotMatch(text, /fix the reason above/, text);
});
