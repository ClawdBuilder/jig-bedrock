import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { registerTeamBedrock } from "../src/catalog.ts";
import { hostImport } from "./support/pi-host.ts";

type Hook = (...args: any[]) => any;
test("a configured AWS profile is the only credential the provider's auth hands on", async () => {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    let provider: any;
    const native = builtinProviders().find((p: any) => p.id === "amazon-bedrock");
    await registerTeamBedrock(
        {
            registerProvider: (p: any) => {
                if (typeof p === "object") provider = p;
            },
        } as any,
        "/unused",
        native,
        [],
        () => undefined,
        "fixture-profile",
    );
    const auth = await provider.auth.apiKey.resolve({
        credential: { key: "private-canary", env: { AWS_SECRET_ACCESS_KEY: "private-canary" } },
    });
    assert.deepEqual(auth, { auth: {}, env: { AWS_PROFILE: "fixture-profile" }, source: "configured AWS profile" });
});
test("the provider has no repository imports or internal environment dependencies", () => {
    const root = resolve(import.meta.dirname, "..");
    for (const file of readdirSync(join(root, "src"))
        .filter((n) => n.endsWith(".ts"))
        .map((n) => `src/${n}`)) {
        const code = readFileSync(join(root, file), "utf8");
        assert.doesNotMatch(
            code,
            /from\s+["'][^"']*(?:extensions\/switchboard\/|daemon\/|bin\/|team\/|\.\.\/shared\.ts|switchboard-v2)/,
        );
        for (const name of code.match(/(?:JIG|HERDR)_[A-Z_]+/g) || [])
            assert.ok(
                [
                    "JIG_BEDROCK",
                    "JIG_BEDROCK_",
                    "JIG_BEDROCK_TEAM",
                    "JIG_BEDROCK_PROFILE",
                    "JIG_BEDROCK_REGIONS",
                    "JIG_BEDROCK_USAGE_DIR",
                    "JIG_BEDROCK_TAG_KEY",
                    "JIG_BEDROCK_TAG_VALUE",
                ].includes(name),
                name,
            );
        assert.doesNotMatch(code, /DaemonClient|python3/);
    }
});
test("refresh replacing a selected ARN keeps input blocked without switching models", async (t) => {
    const { createJigBedrock } = await import("../src/provider.ts");
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
    const controller = await createJigBedrock({
        config: {
            team: "fixture",
            profile: "fixture",
            regions: [region],
            agentDir: root,
            usageDir: root,
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
    assert.ok(notices.some((n) => n.includes("Choose /model")));
    for (const fn of hooks.get("session_shutdown") || []) await fn({}, ctx);
});
