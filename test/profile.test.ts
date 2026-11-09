// The profile chain: setting, JIG_BEDROCK_PROFILE, /login's credential, AWS_PROFILE, AWS_DEFAULT_PROFILE, the default
// profile, then the ambient chain. The listing is cached, and /login asks for a name, never for a secret.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwsDiscovery } from "../src/aws-discovery.ts";
import { loadConfig } from "../src/config.ts";
import {
    createListProfiles,
    createProfileAuth,
    loginWithProfile,
    ProfileResolver,
    type ProfileSettings,
} from "../src/profile.ts";

/** A resolver with a fixed AWS profile listing, and a count of how often the listing was asked for. */
function resolver(settings: ProfileSettings, listing: string[] | undefined = []) {
    let calls = 0;
    const profiles = new ProfileResolver({
        settings,
        listProfiles: async () => {
            calls++;
            return listing;
        },
        now: () => 1_000,
        cacheMs: 1,
    });
    return { profiles, calls: () => calls };
}

test("the setting wins over the credential and the AWS environment", async () => {
    const { profiles } = resolver(
        {
            setting: "from-setting",
            env: { AWS_PROFILE: "from-aws", AWS_DEFAULT_PROFILE: "from-default-env" },
        },
        ["from-setting", "from-aws"],
    );
    assert.deepEqual(await profiles.resolve({ stored: "from-login" }), {
        profile: "from-setting",
        source: "setting",
        exists: true,
    });
});

test("JIG_BEDROCK_PROFILE is the setting, with its own source", async () => {
    const loaded = loadConfig({ raw: { team: "t" }, env: { JIG_BEDROCK_PROFILE: "from-jig-env" } });
    assert.equal(loaded.config?.profile, "from-jig-env");
    assert.equal(loaded.config?.profileSource, "env");
    const { profiles } = resolver(
        { setting: loaded.config?.profile, settingSource: loaded.config?.profileSource, env: {} },
        ["from-jig-env"],
    );
    assert.deepEqual(await profiles.resolve(), { profile: "from-jig-env", source: "env", exists: true });
});

test("/login's credential is next, then AWS_PROFILE, then AWS_DEFAULT_PROFILE", async () => {
    const stored = resolver({ env: {} }, ["from-login", "from-aws", "from-default-env"]);
    assert.deepEqual(await stored.profiles.resolve({ stored: "from-login" }), {
        profile: "from-login",
        source: "login",
        exists: true,
    });
    const aws = resolver({ env: { AWS_PROFILE: "from-aws", AWS_DEFAULT_PROFILE: "from-default-env" } }, [
        "from-aws",
        "from-default-env",
    ]);
    assert.deepEqual(await aws.profiles.resolve(), { profile: "from-aws", source: "AWS_PROFILE", exists: true });
    const old = resolver({ env: { AWS_DEFAULT_PROFILE: "from-default-env" } }, ["from-default-env"]);
    assert.deepEqual(await old.profiles.resolve(), {
        profile: "from-default-env",
        source: "AWS_DEFAULT_PROFILE",
        exists: true,
    });
});

test("the default profile is used only when AWS lists it", async () => {
    const present = resolver({ env: {} }, ["default"]);
    assert.deepEqual(await present.profiles.resolve(), { profile: "default", source: "default", exists: true });
    const absent = resolver({ env: {} }, ["other"]);
    assert.deepEqual(await absent.profiles.resolve(), {});
});

test("an explicit choice that is missing is reported, not replaced", async () => {
    const { profiles } = resolver({ setting: "missing", env: { AWS_PROFILE: "from-aws" } }, ["from-aws"]);
    assert.deepEqual(await profiles.resolve({ stored: "from-login" }), {
        profile: "missing",
        source: "setting",
        exists: false,
    });
});

test("a name that is not a legal profile name is reported", async () => {
    const { profiles } = resolver({ setting: "bad profile", env: {} }, []);
    const choice = await profiles.resolve();
    assert.equal(choice.profile, "bad profile");
    assert.equal(choice.exists, false);
    assert.match(choice.problem ?? "", /not a legal AWS profile name/);
});

test("with no profile and no CLI answer, the environment credential chain is used", async () => {
    const { profiles } = resolver(
        { env: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "secret" } },
        undefined,
    );
    assert.deepEqual(await profiles.resolve(), { ambient: true });
});

test("the listing is cached until invalidated", async () => {
    const { profiles, calls } = resolver({ setting: "work", env: {} }, ["work"]);
    await profiles.resolve();
    await profiles.resolve();
    assert.equal(calls(), 1, "one listing for two resolutions");
    profiles.invalidate();
    await profiles.resolve();
    assert.equal(calls(), 2);
});

test("/login picks a listed profile and stores only its name", async () => {
    const prompts: string[] = [];
    const credential = await loginWithProfile(
        {
            signal: new AbortController().signal,
            prompt: async (prompt) => {
                prompts.push(prompt.type);
                assert.equal(prompt.type, "select");
                assert.deepEqual(
                    prompt.options?.map((option) => option.id),
                    ["profile:work", "type"],
                );
                return "profile:work";
            },
            notify: () => assert.fail("a listed profile needs no warning"),
        },
        async () => ["work"],
    );
    assert.deepEqual(prompts, ["select"]);
    assert.deepEqual(credential, { type: "api_key", env: { AWS_PROFILE: "work" } });
    assert.doesNotMatch(JSON.stringify(credential), /"key"/);
});

test("/login can type a profile, and says when it is not listed yet", async () => {
    const notices: string[] = [];
    const credential = await loginWithProfile(
        {
            signal: new AbortController().signal,
            prompt: async (prompt) => {
                if (prompt.type === "select") return "type";
                assert.equal(prompt.type, "text");
                return "typed-profile";
            },
            notify: (event) => notices.push(event.message),
        },
        async () => ["work"],
    );
    assert.deepEqual(credential, { type: "api_key", env: { AWS_PROFILE: "typed-profile" } });
    assert.match(notices.join("\n"), /typed-profile is not in aws configure list-profiles/);
});

test("/login with no AWS CLI answer asks for a name, says why, and never asks for a secret", async () => {
    const kinds: string[] = [];
    const notices: string[] = [];
    const credential = await loginWithProfile(
        {
            signal: new AbortController().signal,
            prompt: async (prompt) => {
                kinds.push(prompt.type);
                return "my-profile";
            },
            notify: (event) => notices.push(event.message),
        },
        async () => undefined,
    );
    assert.deepEqual(kinds, ["text"]);
    assert.match(notices.join("\n"), /Could not list your AWS profiles; type the name/);
    assert.deepEqual(credential, { type: "api_key", env: { AWS_PROFILE: "my-profile" } });
});

test("/login refuses a name that is not a profile name", async () => {
    await assert.rejects(
        loginWithProfile(
            {
                signal: new AbortController().signal,
                prompt: async () => "bad name",
                notify: () => {},
            },
            async () => [],
        ),
        /not an AWS profile name/,
    );
});

test("the auth never uses a key and never offers a bearer token", async () => {
    const profiles = new ProfileResolver({
        settings: { env: { AWS_BEARER_TOKEN_BEDROCK: "bearer-canary" } },
        listProfiles: async () => [],
    });
    const auth = createProfileAuth(profiles);
    assert.equal(auth.oauth, undefined);
    assert.equal(auth.apiKey?.name, "AWS profile");
    // The bearer variable is not a profile and is not an ambient credential: nothing is configured.
    assert.equal(
        await auth.apiKey?.resolve({
            ctx: { env: async () => undefined, fileExists: async () => false },
            credential: { type: "api_key", key: "key-canary" },
            signal: new AbortController().signal,
        }),
        undefined,
    );
});

test("/login uses its own long listing, not the short cached one", async () => {
    const resolver = new ProfileResolver({
        settings: { env: {} },
        listProfiles: async () => undefined,
    });
    const prompts: string[][] = [];
    const credential = await createProfileAuth(resolver, async () => ["demo-sso"]).apiKey?.login({
        signal: new AbortController().signal,
        prompt: async (prompt) => {
            prompts.push((prompt.options ?? []).map((option) => option.id));
            return prompt.type === "select" ? "profile:demo-sso" : "";
        },
        notify: () => {},
    });
    assert.deepEqual(prompts, [["profile:demo-sso", "type"]]);
    assert.deepEqual(credential, { type: "api_key", env: { AWS_PROFILE: "demo-sso" } });
});

test("the profile listing has a short timeout and a long one for /login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-slow-aws-"));
    try {
        const script = join(dir, "aws");
        writeFileSync(script, "#!/bin/sh\nsleep 1.5\nprintf 'demo-sso\\n'\n");
        chmodSync(script, 0o755);
        const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
        assert.equal(await createListProfiles(env, 400)(), undefined, "the start-up listing gives up early");
        assert.deepEqual(await createListProfiles(env, 5_000)(), ["demo-sso"], "/login waits for the CLI");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("ambient credentials resolve without a profile and without a key", async () => {
    const profiles = new ProfileResolver({
        settings: { env: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "secret-canary" } },
        listProfiles: async () => [],
    });
    const resolved = await createProfileAuth(profiles).apiKey?.resolve({
        ctx: { env: async () => undefined, fileExists: async () => false },
        signal: new AbortController().signal,
    });
    assert.deepEqual(resolved, { auth: {}, source: "AWS credential chain" });
    assert.doesNotMatch(JSON.stringify(resolved), /secret-canary/);
});

test("discovery omits --profile when there is none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-ambient-"));
    try {
        const loaded = loadConfig({ raw: { regions: ["us-east-1"] }, env: {} });
        assert.ok(loaded.config);
        assert.equal(loaded.config.profile, undefined);
        const calls: string[][] = [];
        const discovery = createAwsDiscovery(
            loaded.config,
            async (_program, args) => {
                calls.push(args);
                if (args[0] === "sts") return JSON.stringify({ Account: "123456789012" });
                if (args[0] === "bedrock") return JSON.stringify({ inferenceProfileSummaries: [] });
                return "{}";
            },
            join(dir, "catalog.json"),
            () => Date.now(),
        );
        assert.equal(await discovery.refresh(true), "ok");
        assert.ok(calls.length > 0);
        for (const args of calls) assert.equal(args.includes("--profile"), false, args.join(" "));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
