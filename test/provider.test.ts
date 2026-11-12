/* biome-ignore-all lint/suspicious/noExplicitAny: fixtures stand in for Pi objects */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { registerBedrockProvider } from "../src/catalog.ts";
import { createProfileAuth, ProfileResolver } from "../src/profile.ts";
import { hostImport } from "./support/pi-host.ts";

type Hook = (...args: any[]) => any;
test("the provider's auth hands on only the profile, never a key", async () => {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    let provider: any;
    const native = builtinProviders().find((p: any) => p.id === "amazon-bedrock");
    const profiles = new ProfileResolver({
        settings: { setting: "fixture-profile", env: {} },
        listProfiles: async () => ["fixture-profile"],
    });
    await registerBedrockProvider(
        {
            registerProvider: (p: any) => {
                if (typeof p === "object") provider = p;
            },
        } as any,
        "/unused",
        native,
        [],
        () => undefined,
        { profile: () => "fixture-profile", auth: createProfileAuth(profiles) },
    );
    assert.equal(provider.auth.oauth, undefined);
    assert.equal(provider.auth.apiKey.name, "AWS profile");
    const auth = await provider.auth.apiKey.resolve({
        ctx: { env: async () => undefined, fileExists: async () => false },
        credential: { key: "private-canary", env: { AWS_SECRET_ACCESS_KEY: "private-canary" } },
        signal: new AbortController().signal,
    });
    assert.deepEqual(auth, { auth: {}, env: { AWS_PROFILE: "fixture-profile" }, source: "bedrock.profile" });
    assert.doesNotMatch(JSON.stringify(auth), /private-canary/);
});

test("a profile chosen at /login is the profile, with no key in the credential", async () => {
    const profiles = new ProfileResolver({
        settings: { env: {} },
        listProfiles: async () => ["from-login"],
    });
    const auth = await createProfileAuth(profiles).apiKey?.resolve({
        ctx: { env: async () => undefined, fileExists: async () => false },
        credential: { type: "api_key", env: { AWS_PROFILE: "from-login" } },
        signal: new AbortController().signal,
    });
    assert.deepEqual(auth, { auth: {}, env: { AWS_PROFILE: "from-login" }, source: "/login" });
});
test("the provider has no repository imports or internal environment dependencies", () => {
    const root = resolve(import.meta.dirname, "..");
    for (const file of readdirSync(join(root, "src"))
        .filter((n) => n.endsWith(".ts"))
        .map((n) => `src/${n}`)) {
        const code = readFileSync(join(root, file), "utf8");
        assert.doesNotMatch(code, /from\s+["'][^"']*(?:daemon\/|bin\/|team\/|\.\.\/shared\.ts)/);
        for (const name of code.match(/JIG_[A-Z_]+/g) || [])
            assert.ok(
                [
                    "JIG_BEDROCK",
                    "JIG_BEDROCK_",
                    "JIG_BEDROCK_TEAM",
                    "JIG_BEDROCK_PROFILE",
                    "JIG_BEDROCK_REGIONS",
                    "JIG_BEDROCK_TAG_KEY",
                    "JIG_BEDROCK_TAG_VALUE",
                    "JIG_BEDROCK_DEBUG",
                    "JIG_BEDROCK_PRESET",
                ].includes(name),
                name,
            );
    }
});
test("refresh replacing a selected ARN keeps input blocked without switching models", async (t) => {
    const { createBedrockProvider } = await import("../src/provider.ts");
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    const foundation = builtinProviders()
        .find((p: any) => p.id === "amazon-bedrock")
        .getModels()[0];
    const root = mkdtempSync(join(tmpdir(), "bedrock-refresh-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const region = "us-east-1",
        profile = {
            arn: `arn:aws:bedrock:${region}:123456789012:application-inference-profile/old`,
            profile_name: "Fixture",
            foundation_model_id: foundation.id,
            region,
        };
    const cache: any = {
        schema: 1,
        team: "fixture",
        aws_profile: "fixture",
        account_id: "123456789012",
        regions: [region],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles: [profile],
    };
    const hooks = new Map<string, Hook[]>(),
        notices: string[] = [];
    const pi: any = {
        on: (name: string, fn: Hook) => hooks.set(name, [...(hooks.get(name) || []), fn]),
        registerProvider() {},
        registerCommand() {},
        events: { emit() {} },
        setModel: () => assert.fail("silent model switch"),
    };
    const controller = await createBedrockProvider({
        config: {
            team: "fixture",
            profile: "fixture",
            regions: [region],
            agentDir: root,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: { load: () => cache, refresh: async () => "ok" },
        ssoRecover: async () => {},
        budget: { load: () => undefined, refresh: async () => {} },
        backgroundRefresh: false,
        usageEvents: false,
    })(pi);
    assert.equal(controller?.failed, false);
    assert.equal(controller?.models.length, 1);
    const selected = { ...controller!.models[0], provider: "jig-bedrock" },
        ctx: any = {
            model: selected,
            sessionManager: { getBranch: () => [], getSessionId: () => "fixture" },
            ui: { notify: (value: string) => notices.push(value) },
        };
    for (const fn of hooks.get("session_start") || []) await fn({}, ctx);
    cache.profiles = [{ ...profile, arn: profile.arn.replace("/old", "/replacement") }];
    await controller!.refresh();
    assert.equal(controller!.models[0]!.id, selected.id);
    assert.notEqual(controller!.models[0]!.arn, selected.arn);
    assert.equal(hooks.get("input")![0]!({}, ctx).action, "handled");
    assert.doesNotMatch(notices.join("\n"), /catalog updated|Choose \/model/);
    const other = builtinProviders()
        .find((p: any) => p.id === "amazon-bedrock")
        .getModels()[1];
    cache.profiles = [
        profile,
        { ...profile, arn: profile.arn.replace("/old", "/new"), foundation_model_id: other.id, profile_name: "New" },
    ];
    await controller!.refresh();
    assert.ok(
        notices.some((n) => n.includes("1 new model in /model")),
        notices.join("\n"),
    );
    cache.warnings = [
        "No application inference profiles matched CostCenter=42 in us-east-1. Check bedrock.tagKey/tagValue.",
    ];
    await controller!.refresh();
    assert.ok(
        notices.some((n) => n.includes("CostCenter=42")),
        notices.at(-1),
    );
    cache.warnings = [];
    cache.errors = [{ profile: "arn:bad", message: "denied" }];
    await controller!.refresh();
    assert.ok(
        notices.some((n) => n.includes("arn:bad: denied")),
        notices.at(-1),
    );
    cache.errors = [];
    cache.profiles = [];
    await controller!.refresh();
    assert.ok(
        notices.some((n) => n.includes(`${selected.id} is no longer in your account`)),
        notices.join("\n"),
    );
    for (const fn of hooks.get("session_shutdown") || []) await fn({}, ctx);
});
