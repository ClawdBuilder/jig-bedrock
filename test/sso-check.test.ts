// Whether the profile's SSO session is still good, checked the way Switchboard's bin/aws-sso-check.ts did it: a cached token that
// stays valid is enough; otherwise the AWS SDK's credential chain answers. Every test runs on a fake home and a fake SDK: nothing
// reads a real token cache or reaches AWS, and nothing of a credential is in an answer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { CredentialProvider } from "../src/pi-host.ts";
import type { SsoCheckDeps } from "../src/sso-check.ts";
import { checkSso, classify, ssoKey, tokenFresh } from "../src/sso-check.ts";

const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString();
const EXPIRED_MESSAGE =
    "The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.";

describe("what the SDK's error means", () => {
    test("is a sign-in when it says to run aws sso login, or that the token has expired, and nothing else", () => {
        assert.equal(classify(new Error(EXPIRED_MESSAGE)), "sign-in");
        assert.equal(
            classify(new Error("Token is expired. To refresh this SSO session run 'aws sso login'")),
            "sign-in",
        );
        assert.equal(classify("Token is expired"), "sign-in");
        assert.equal(classify(new Error("Could not resolve credentials using profile: [fixture]")), "error");
        assert.equal(classify(new Error("getaddrinfo ENOTFOUND portal.sso.us-east-1.amazonaws.com")), "error");
        assert.equal(classify(new Error("timed out")), "error");
        assert.equal(classify(undefined), "error");
    });
});

describe("the SSO session a profile signs in with", () => {
    const config = [
        "[default]",
        "sso_start_url = https://legacy.example.com/start",
        "",
        "[profile my-bedrock-profile]",
        "sso_session = work",
        "sso_account_id = 123456789012",
        "",
        "[profile older]",
        "sso_start_url = https://older.example.com/start",
        "region = us-east-1",
        "",
        "[profile both]",
        "sso_start_url = https://both.example.com/start",
        "sso_session = chosen",
        "",
        "[sso-session work]",
        "sso_start_url = https://work.example.com/start",
        "",
        "[profile plain]",
        "region = us-east-1",
    ].join("\n");

    test("is the sso_session, or the start URL of an older profile, or the default profile's, as the AWS CLI names the cache file", () => {
        assert.equal(ssoKey(config, "my-bedrock-profile"), "work");
        assert.equal(ssoKey(config, "older"), "https://older.example.com/start");
        assert.equal(ssoKey(config, "default"), "https://legacy.example.com/start");
        assert.equal(ssoKey(config, "both"), "chosen", "a session name wins over a start URL");
        assert.equal(ssoKey(config, "plain"), undefined);
        assert.equal(ssoKey(config, "absent"), undefined);
        assert.equal(ssoKey(config.replaceAll("\n", "\r\n"), "my-bedrock-profile"), "work", "Windows line endings");
    });
});

describe("a cached token", () => {
    test("is fresh while it stays valid for the margin, and is not fresh when it cannot be read", () => {
        const cache = (expiresAt: string) => JSON.stringify({ expiresAt });
        assert.equal(tokenFresh(cache(minutes(60)), NOW), true);
        assert.equal(tokenFresh(cache(minutes(16)), NOW), true);
        assert.equal(tokenFresh(cache(minutes(14)), NOW), false, "inside the 15 minute margin");
        assert.equal(tokenFresh(cache(minutes(-5)), NOW), false);
        assert.equal(tokenFresh(cache(minutes(14)), NOW, 60_000), true, "the margin is a parameter");
        assert.equal(tokenFresh("{}", NOW), false);
        assert.equal(tokenFresh("not json", NOW), false);
        assert.equal(tokenFresh(JSON.stringify({ expiresAt: "tomorrow-ish" }), NOW), false);
    });
});

describe("the check", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** A home with an AWS config for `my-bedrock-profile` (session `work`) and, when given, the token cache the CLI would have written. */
    function setup(cached?: { expiresAt: string }, extra: Partial<SsoCheckDeps> = {}) {
        const home = mkdtempSync(path.join(tmpdir(), "bedrock-sso-check-"));
        dirs.push(home);
        mkdirSync(path.join(home, ".aws/sso/cache"), { recursive: true });
        writeFileSync(path.join(home, ".aws/config"), "[profile my-bedrock-profile]\nsso_session = work\n");
        if (cached) {
            const file = `${createHash("sha1").update("work").digest("hex")}.json`;
            // The accessToken is a canary: the check reads the expiry and nothing else.
            writeFileSync(
                path.join(home, ".aws/sso/cache", file),
                JSON.stringify({ ...cached, accessToken: "private-canary" }),
            );
        }
        const provided: Array<{ profile: string }> = [];
        const deps = (provider: () => Promise<unknown>): SsoCheckDeps => ({
            env: {},
            home,
            readText: (file) => readFileSync(file, "utf8"),
            now: () => NOW,
            credentialProvider: () =>
                ((init: { profile: string }) => {
                    provided.push(init);
                    return provider;
                }) as CredentialProvider,
            timeoutMs: 5_000,
            ...extra,
        });
        return { home, provided, deps };
    }

    test("passes on a token that stays valid, without loading the SDK", async () => {
        const { deps } = setup({ expiresAt: minutes(90) });
        const state = await checkSso(
            "my-bedrock-profile",
            deps(async () => assert.fail("the SDK is not needed")),
        );
        assert.equal(state, "ok");
    });

    test("asks the SDK about this profile when the token is close to expiry, and is ok when the credentials resolve", async () => {
        const { deps, provided } = setup({ expiresAt: minutes(5) });
        const state = await checkSso(
            "my-bedrock-profile",
            deps(async () => ({ accessKeyId: "private-canary", secretAccessKey: "private-canary" })),
        );
        assert.equal(state, "ok");
        assert.deepEqual(provided, [{ profile: "my-bedrock-profile" }]);
        assert.equal(state.includes("canary"), false, "the answer is one word");
    });

    test("asks the SDK when there is no token cache, or no config for the profile", async () => {
        for (const profile of ["my-bedrock-profile", "no-such-profile"]) {
            const { deps, provided } = setup(undefined);
            assert.equal(
                await checkSso(
                    profile,
                    deps(async () => ({})),
                ),
                "ok",
            );
            assert.deepEqual(provided, [{ profile }]);
        }
    });

    test("says sign-in when the SDK says the SSO session has expired", async () => {
        const { deps } = setup({ expiresAt: minutes(-60) });
        const state = await checkSso(
            "my-bedrock-profile",
            deps(async () => {
                throw new Error(EXPIRED_MESSAGE);
            }),
        );
        assert.equal(state, "sign-in");
    });

    test("says error, not sign-in, when the check itself fails: another error, no SDK, a stalled SDK, a cancelled check", async () => {
        const failing = async () => {
            throw new Error("getaddrinfo ENOTFOUND private-canary.example.com");
        };
        assert.equal(await checkSso("my-bedrock-profile", setup().deps(failing)), "error");
        const noSdk = setup(undefined, {
            credentialProvider: () => {
                throw new Error("Pi's install was not found");
            },
        });
        assert.equal(await checkSso("my-bedrock-profile", noSdk.deps(failing)), "error");
        const stalled = setup(undefined, { timeoutMs: 30 });
        assert.equal(
            await checkSso(
                "my-bedrock-profile",
                stalled.deps(() => new Promise(() => {})),
            ),
            "error",
        );
        const controller = new AbortController();
        const cancelled = setup();
        const pending = checkSso(
            "my-bedrock-profile",
            cancelled.deps(() => new Promise(() => {})),
            controller.signal,
        );
        controller.abort();
        assert.equal(await pending, "error");
    });

    test("a failure that comes after the time ran out is not left unhandled", async () => {
        const late = setup(undefined, { timeoutMs: 10 });
        const state = await checkSso(
            "my-bedrock-profile",
            late.deps(
                () =>
                    new Promise((_resolve, reject) => {
                        setTimeout(() => reject(new Error(EXPIRED_MESSAGE)), 40);
                    }),
            ),
        );
        assert.equal(state, "error", "the answer was given when the time ran out");
        await new Promise((resolve) => setTimeout(resolve, 80));
    });

    test("reads the config named by AWS_CONFIG_FILE, as the SDK does", async () => {
        const { home, deps } = setup({ expiresAt: minutes(90) });
        // The default config has no profile "elsewhere"; the file in the variable has, signed in with the same cached session.
        const other = path.join(home, "other-config");
        writeFileSync(other, "[profile elsewhere]\nsso_session = work\n");
        const base = deps(async () => assert.fail("a fresh token needs no SDK"));
        assert.equal(await checkSso("elsewhere", { ...base, env: { AWS_CONFIG_FILE: other } }), "ok");
    });
});
