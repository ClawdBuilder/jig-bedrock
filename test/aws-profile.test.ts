// The shared sign-in preflight: a profile must be named by `aws configure list-profiles` (when a person is waiting) and
// must be an IAM Identity Center profile in the AWS config. It never reads the credentials file and never starts a child
// for a profile that cannot work.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkedRecovery, parseAwsConfig, profileProblem } from "../src/aws-profile.ts";
import { SsoRecoveryError } from "../src/sso.ts";

const MODERN = [
    "[profile demo-sso]",
    "sso_session = demo",
    "sso_account_id = 123456789012",
    "sso_role_name = ReadOnly",
    "region = us-east-1",
    "[profile keys]",
    "region = us-east-1",
    "[sso-session demo]",
    "sso_region = us-east-1",
    "sso_start_url = https://my-sso-portal.awsapps.com/start",
].join("\n");
const LEGACY = [
    "[profile legacy]",
    "sso_start_url = https://my-sso-portal.awsapps.com/start",
    "sso_region = us-east-1",
].join("\n");

function configWith(text: string): { env: NodeJS.ProcessEnv; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-aws-config-"));
    const file = join(dir, "config");
    writeFileSync(file, text);
    return { env: { AWS_CONFIG_FILE: file, HOME: dir }, dir };
}

test("parses profile and sso-session sections with their keys", () => {
    const sections = parseAwsConfig(MODERN);
    assert.equal(sections.get("profile:demo-sso")?.get("sso_session"), "demo");
    assert.equal(sections.get("profile:keys")?.get("sso_session"), undefined);
    assert.equal(sections.get("sso-session:demo")?.get("sso_start_url"), "https://my-sso-portal.awsapps.com/start");
});

test("a profile the CLI does not list is named, with the way to choose one", async () => {
    const { env, dir } = configWith(MODERN);
    try {
        const problem = await profileProblem("missing", { list: async () => ["demo-sso"], env });
        assert.match(problem ?? "", /missing is not in aws configure list-profiles/);
        assert.match(problem ?? "", /\/login → Sign in with an API key → Amazon Bedrock \(jig-bedrock\)/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a listing that cannot answer says so instead of guessing", async () => {
    const { env, dir } = configWith(MODERN);
    try {
        const problem = await profileProblem("demo-sso", { list: async () => undefined, env });
        assert.match(problem ?? "", /Could not list your AWS profiles/);
        assert.match(problem ?? "", /aws configure list-profiles/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a keys profile is refused, and says why /aws-login does not apply", async () => {
    const { env, dir } = configWith(MODERN);
    try {
        const problem = await profileProblem("keys", { list: async () => ["keys"], env });
        assert.match(problem ?? "", /keys is not an IAM Identity Center \(SSO\) profile/);
        assert.match(problem ?? "", /does not need it/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("modern and legacy SSO profiles pass", async () => {
    const modern = configWith(MODERN);
    try {
        assert.equal(await profileProblem("demo-sso", { list: async () => ["demo-sso"], env: modern.env }), undefined);
    } finally {
        rmSync(modern.dir, { recursive: true, force: true });
    }
    const legacy = configWith(LEGACY);
    try {
        assert.equal(await profileProblem("legacy", { list: async () => ["legacy"], env: legacy.env }), undefined);
    } finally {
        rmSync(legacy.dir, { recursive: true, force: true });
    }
});

test("a named sso-session that the config does not define is reported", async () => {
    const { env, dir } = configWith("[profile broken]\nsso_session = gone\n");
    try {
        const problem = await profileProblem("broken", { list: async () => ["broken"], env });
        assert.match(problem ?? "", /names the SSO session gone/);
        assert.match(problem ?? "", /\[sso-session gone\]/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a missing config file is not an SSO profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-no-config-"));
    try {
        const problem = await profileProblem("demo-sso", {
            list: async () => ["demo-sso"],
            env: { AWS_CONFIG_FILE: join(dir, "absent"), HOME: dir },
        });
        assert.match(problem ?? "", /not in the AWS config/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the shared recovery refuses a bad manual profile before any child starts, and passes a good one", async () => {
    const { env, dir } = configWith(MODERN);
    try {
        let calls = 0;
        const recovery = checkedRecovery(
            async () => {
                calls++;
            },
            { manualList: async () => ["demo-sso", "keys"], env },
        );
        await assert.rejects(
            () => recovery("keys"),
            (error: unknown) => {
                assert.ok(error instanceof SsoRecoveryError);
                assert.match((error as Error).message, /not an IAM Identity Center \(SSO\) profile/);
                return true;
            },
        );
        assert.equal(calls, 0);
        await recovery("demo-sso");
        assert.equal(calls, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the automatic repair does not wait for a profile listing", async () => {
    const { env, dir } = configWith(MODERN);
    try {
        let calls = 0;
        const recovery = checkedRecovery(
            async () => {
                calls++;
            },
            { manualList: async () => undefined, env },
        );
        // The manual path cannot list, so it refuses; a request path checks only the config and proceeds.
        await assert.rejects(() => recovery("demo-sso"));
        await recovery("demo-sso", undefined, "request");
        assert.equal(calls, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
