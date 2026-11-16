import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Catalog } from "../src/catalog.ts";
import { createBedrockProvider } from "../src/provider.ts";

const catalog: Catalog = {
    schema: 1,
    mode: "system",
    aws_profile: "sso",
    account_id: "123456789012",
    regions: ["us-east-1"],
    profiles: [],
};

for (const [name, message, expired] of [
    ["network", "AWS did not answer for sso. Check the profile and your network access, then try again.", false],
    ["invalid token", "UnrecognizedClientException: The security token included in the request is invalid.", false],
    ["real expiry", "Error loading SSO Token: Token for sso has expired", true],
] as const) {
    test(`the doctor says sign-in expired only for a real expiry: ${name}`, async (t) => {
        const dir = mkdtempSync(join(tmpdir(), "bedrock-doctor-expiry-"));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        mkdirSync(join(dir, "bin"), { recursive: true });
        writeFileSync(join(dir, "bin", "aws"), "#!/bin/sh\necho aws-cli/2.34.46\n", { mode: 0o755 });
        const testEnv = {
            HOME: dir,
            PI_CODING_AGENT_DIR: join(dir, "agent"),
            AWS_CONFIG_FILE: join(dir, "config"),
            PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        };
        const config = join(dir, "config");
        writeFileSync(
            config,
            "[profile sso]\nsso_session = s\n[sso-session s]\nsso_region = us-east-1\nsso_start_url = https://example.awsapps.com/start\n",
        );
        mkdirSync(join(dir, "agent"), { recursive: true });
        writeFileSync(join(dir, "agent", "bedrock.json"), JSON.stringify({ profile: "sso", regions: ["us-east-1"] }));
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
            env: testEnv,
            config: {
                profile: "sso",
                regions: ["us-east-1"],
                agentDir: join(dir, "agent"),
                ssoLoginCommand: [],
                signInAtStart: false,
            },
            catalog: { load: () => catalog, refresh: async () => "ok", status: () => "ok" } as never,
            listProfiles: async () => ["sso"],
            verifyProfile: async () => ({ ok: false, message }),
            ssoRecover: async () => {},
            check: async () => ({
                node: { status: "ready", version: "22.19.0" },
                aws: { status: "ready", version: "2.34.46" },
                platform: "linux",
            }),
            backgroundRefresh: false,
        } as never)(pi as never);
        const notices: string[] = [];
        await commands.get("bedrock").handler("doctor", {
            hasUI: true,
            mode: "rpc",
            signal: new AbortController().signal,
            ui: { notify: (text: string) => notices.push(text), setStatus() {} },
            sessionManager: { getSessionId: () => "s", getBranch: () => [] },
            modelRegistry: { find: () => undefined },
        });
        assert.equal(notices.join("\n").includes("Sign-in: sign-in expired"), expired, notices.join("\n"));
        assert.ok(providers.length > 0);
    });
}
