// /login must check the local AWS CLI before asking anything, and the login check must name a missing aws command.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyAwsProfile } from "../src/aws-profile.ts";
import { jigBedrock } from "../src/index.ts";

function harness() {
    const providers: any[] = [];
    const pi = {
        on() {},
        registerProvider(provider: any) {
            if (typeof provider !== "string") providers.push(provider);
        },
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    return { pi, providers };
}

async function loginWithCli(status: "missing" | "old", method: "existing" | "sso-new") {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-login-cli-"));
    const env = { HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), AWS_CONFIG_FILE: join(dir, "config") };
    writeFileSync(env.AWS_CONFIG_FILE, "[profile demo]\nregion = us-east-1\n");
    const before = readFileSync(env.AWS_CONFIG_FILE, "utf8");
    const { pi, providers } = harness();
    await (
        jigBedrock({
            env,
            listProfiles: async () => ["demo"],
            check: async () =>
                ({
                    node: { status: "ready", version: "22.19.0" },
                    aws: { status, version: status === "old" ? "1.32.0" : undefined },
                    platform: "linux",
                }) as never,
        }) as never
    )(pi as never);
    const provider = providers.find((entry) => entry?.id === "jig-bedrock");
    const notices: string[] = [];
    let prompts = 0;
    await assert.rejects(
        provider.auth.apiKey.login({
            signal: new AbortController().signal,
            prompt: async () => {
                prompts++;
                return method === "existing" ? "existing" : "sso-new";
            },
            notify: (event: any) => notices.push(event.message ?? ""),
        }),
        /AWS CLI v2 is required/,
    );
    assert.equal(prompts, 0, "no question is asked");
    assert.match(notices.join("\n"), /needs AWS CLI v2 for sign-in and listing models/);
    assert.match(notices.join("\n"), /Use a Bedrock API key with Pi's own provider/);
    assert.equal(existsSync(join(env.PI_CODING_AGENT_DIR, "bedrock.json")), false);
    assert.equal(readFileSync(env.AWS_CONFIG_FILE, "utf8"), before, "the AWS config is untouched");
    rmSync(dir, { recursive: true, force: true });
}

test("no aws on PATH stops an existing-profile login before the first question", () =>
    loginWithCli("missing", "existing"));
test("AWS CLI v1 stops a new-SSO login before the first question", () => loginWithCli("old", "sso-new"));

test("the login check names a missing aws command, not a network failure", async () => {
    const result = await verifyAwsProfile("demo", {
        run: async () => {
            const error = new Error("spawn aws ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
        },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /the aws command was not found/);
    assert.doesNotMatch(result.ok ? "" : result.message, /AWS did not answer/);
});

test("no aws on PATH stops a new-SSO login before the first question", () => loginWithCli("missing", "sso-new"));
test("AWS CLI v1 stops an existing-profile login before the first question", () => loginWithCli("old", "existing"));
