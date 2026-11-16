import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkedRecovery, profileProblem, ssoSignInTarget } from "../src/aws-profile.ts";
import { SsoRecoveryError } from "../src/sso.ts";

const CONFIG = [
    "[profile keys]",
    "region = us-east-1",
    "[profile deploy]",
    "role_arn = arn:aws:iam::123456789012:role/Deploy",
    "source_profile = base",
    "[profile loop]",
    "role_arn = arn:aws:iam::123456789012:role/Loop",
    "source_profile = loop",
    "[profile base]",
    "sso_session = base",
    "[sso-session base]",
    "sso_region = us-east-1",
    "sso_start_url = https://example.awsapps.com/start",
].join("\n");

function folder() {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-b7-"));
    const file = join(dir, "config");
    writeFileSync(file, CONFIG);
    return { dir, env: { HOME: dir, AWS_CONFIG_FILE: file } };
}

test("a role profile signs in its one source_profile", async () => {
    const { dir, env } = folder();
    try {
        assert.deepEqual(ssoSignInTarget("deploy", env), { target: "base", via: "deploy" });
        assert.equal(await profileProblem("deploy", { env }), undefined);
        let signed = "";
        const recover = checkedRecovery(
            async (profile) => {
                signed = profile;
            },
            { manualList: async () => ["deploy", "base", "keys", "loop"], env },
        );
        await recover("deploy", undefined, "manual");
        assert.equal(signed, "base");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a keys profile does not start aws sso login and says what to do", async () => {
    const { dir, env } = folder();
    try {
        let called = false;
        const recover = checkedRecovery(
            async () => {
                called = true;
            },
            { manualList: async () => ["keys"], env },
        );
        await assert.rejects(recover("keys", undefined, "manual"), (error: unknown) => {
            assert.ok(error instanceof SsoRecoveryError);
            assert.match(error.detail ?? "", /signs in with its own keys or role/);
            assert.match(error.detail ?? "", /sts get-caller-identity/);
            return true;
        });
        assert.equal(called, false, "the SSO login was not started");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a source_profile loop is refused", async () => {
    const { dir, env } = folder();
    try {
        const recover = checkedRecovery(async () => {}, { manualList: async () => ["loop"], env });
        await assert.rejects(recover("loop", undefined, "manual"), /names itself as source_profile/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a browser failure prints its recovery hint, not a category", async () => {
    const { dir, env } = folder();
    try {
        const recover = checkedRecovery(
            async () => {
                throw new SsoRecoveryError("browser");
            },
            { manualList: async () => ["base"], env },
        );
        await assert.rejects(recover("base", undefined, "manual"), (error: unknown) => {
            assert.match((error as Error).message, /browser/);
            return true;
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the start-up sign-in uses the checked recovery for keys and role profiles", async () => {
    const { dir, env } = folder();
    try {
        const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
        const pi = {
            on(name: string, hook: (event: any, ctx: any) => unknown) {
                hooks.set(name, [...(hooks.get(name) ?? []), hook]);
            },
        };
        const signed: string[] = [];
        const checked = checkedRecovery(
            async (profile) => {
                signed.push(profile);
            },
            { manualList: async () => ["keys", "deploy", "base"], env },
        );
        const { registerSignInAtStart } = await import("../src/start-sign-in.ts");
        registerSignInAtStart(pi as never, {
            signInAtStart: true,
            profile: () => "keys",
            recover: checked,
            check: async () => "sign-in",
            refresh: async () => {},
        });
        const ctx = { hasUI: true, mode: "tui", ui: { notify() {} } };
        for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(signed, [], "keys does not start an SSO login");

        const hooks2 = new Map<string, Array<(event: any, ctx: any) => unknown>>();
        const pi2 = {
            on(name: string, hook: (event: any, ctx: any) => unknown) {
                hooks2.set(name, [...(hooks2.get(name) ?? []), hook]);
            },
        };
        registerSignInAtStart(pi2 as never, {
            signInAtStart: true,
            profile: () => "deploy",
            recover: checked,
            check: async () => "sign-in",
            refresh: async () => {},
        });
        for (const hook of hooks2.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(signed, ["base"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
