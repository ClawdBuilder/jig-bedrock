// The doctor's next step after a failed sign-in check must fit the profile: an SSO profile is repaired with /bedrock
// login, while a keys or role profile is checked with the AWS CLI, so the two commands cannot send a person in a circle.
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
].join("\n");

for (const [profile, advice] of [
    ["keys", { keys: true }],
    ["deploy", { keys: true }],
    ["sso", { keys: false }],
] as const) {
    test(`a failed sign-in check on the ${profile} profile points at what can fix it`, async (t) => {
        const dir = mkdtempSync(join(tmpdir(), "bedrock-doctor-sign-in-"));
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
        const commands = new Map<string, unknown>();
        const pi = {
            on() {},
            registerProvider() {},
            registerCommand(name: string, value: unknown) {
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
            listProfiles: async () => ["keys", "deploy", "sso"],
            // A sign-in check that failed for a reason neither expiry nor a permission: the profile type alone decides
            // the next step.
            verifyProfile: async () => ({
                ok: false,
                message: `AWS did not answer for ${profile}. Check the profile and your network access, then try again.`,
            }),
            ssoRecover: async () => {},
            check: async () => ({
                node: { status: "ready", version: "22.19.0" },
                aws: { status: "ready", version: "2.34.46" },
                platform: "linux",
            }),
            backgroundRefresh: false,
        } as never)(pi as never);
        const notices: string[] = [];
        const handler = commands.get("bedrock") as { handler: (args: string, ctx: unknown) => Promise<void> };
        await handler.handler("doctor", {
            hasUI: true,
            mode: "rpc",
            signal: new AbortController().signal,
            ui: { notify: (text: string) => notices.push(text), setStatus() {} },
            sessionManager: { getSessionId: () => "s", getBranch: () => [] },
            modelRegistry: { find: () => undefined },
        });
        const text = notices.join("\n");
        const next = text.split("\n").filter((line) => line.startsWith("Next: "));
        assert.ok(next.length > 0, text);
        const first = next[0];
        assert.ok(first !== undefined, text);
        if (advice.keys) {
            assert.doesNotMatch(text, /Next: \/bedrock login/, text);
            assert.match(
                first,
                /^Next: check the keys or role for (?:keys|deploy) with "aws sts get-caller-identity --profile (?:keys|deploy)", or refresh the keys, then \/bedrock doctor\.$/,
                text,
            );
        } else {
            assert.equal(first, "Next: /bedrock login", text);
        }
    });
}
