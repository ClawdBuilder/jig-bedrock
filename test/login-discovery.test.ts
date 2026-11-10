// The login flow and /aws-login as a person meets them: choosing a profile starts discovery before the dialog closes,
// and /aws-login refuses a profile that does not exist or is not an SSO profile instead of starting a doomed sign-in.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CatalogSource } from "../src/aws-discovery.ts";
import { jigBedrock } from "../src/index.ts";

type Hook = (...args: any[]) => any;

function harness() {
    const hooks = new Map<string, Hook[]>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const providers: any[] = [];
    const pi = {
        on(name: string, hook: Hook) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            if (typeof provider !== "string") providers.push(provider);
        },
        registerCommand(name: string, options: any) {
            commands.set(name, options);
        },
        events: { emit() {} },
        setModel: () => false,
    };
    return { pi, hooks, commands, providers };
}

const CONFIG = [
    "[profile demo-sso]",
    "sso_session = demo",
    "sso_account_id = 123456789012",
    "sso_role_name = ReadOnly",
    "[profile keys]",
    "region = us-east-1",
    "[sso-session demo]",
    "sso_region = us-east-1",
    "sso_start_url = https://my-sso-portal.awsapps.com/start",
].join("\n");

function folder(): { dir: string; env: NodeJS.ProcessEnv } {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-login-flow-"));
    const config = join(dir, "config");
    writeFileSync(config, CONFIG);
    return {
        dir,
        env: { HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), AWS_CONFIG_FILE: config },
    };
}

async function build(options: {
    env: NodeJS.ProcessEnv;
    list: string[];
    loginList?: string[];
    catalog?: CatalogSource;
}) {
    const { pi, commands, providers } = harness();
    await (
        jigBedrock({
            env: options.env,
            listProfiles: async () => options.list,
            loginListProfiles: async () => options.loginList ?? options.list,
            catalog: options.catalog ?? { load: () => undefined, refresh: async () => "ok" },
            verifyProfile: async () => ({ ok: true }),
        }) as never
    )(pi as never);
    const provider = providers.find((entry) => entry?.id === "jig-bedrock");
    assert.ok(provider, "the Bedrock provider is registered");
    return { provider, commands };
}

test("choosing a profile at /login starts discovery and says what is happening", async () => {
    const { dir, env } = folder();
    try {
        let refreshes = 0;
        const catalog: CatalogSource = {
            load: () => undefined,
            refresh: async () => {
                refreshes++;
                return "ok";
            },
        };
        const { provider } = await build({ env, list: ["work"], catalog });
        const notices: Array<{ type: string; message?: string }> = [];
        const credential = await provider.auth.apiKey.login({
            signal: new AbortController().signal,
            prompt: async (prompt: any) => {
                if (prompt.type === "select") {
                    if (prompt.message?.includes("How do you sign in to AWS?")) return "existing";
                    if (prompt.message === "Which Bedrock profiles should be listed?") return "system";
                    return "profile:work";
                }
                return "";
            },
            notify: (event: any) => notices.push({ type: event.type, message: event.message }),
        });
        assert.deepEqual(credential, { type: "api_key", env: { AWS_PROFILE: "work" } });
        assert.equal("key" in credential, false, "no secret is stored");
        const saved = JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR as string, "bedrock.json"), "utf8"));
        assert.deepEqual(saved.regions, ["us-east-1"], "the discovery choice is saved");
        assert.equal("profile" in saved, false, "the profile belongs to the credential");
        assert.equal(refreshes, 1, "the login starts discovery itself");
        const text = notices.map((notice) => `${notice.type}:${notice.message ?? ""}`).join("\n");
        assert.match(text, /progress:Looking up your AWS profiles…/);
        assert.match(text, /progress:Loading Bedrock models…/);
        assert.match(text, /not loaded yet/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("/aws-login refuses a profile that is not in aws configure list-profiles", async () => {
    const { dir, env } = folder();
    try {
        const { commands } = await build({ env: { ...env, JIG_BEDROCK_PROFILE: "missing" }, list: ["demo-sso"] });
        const notices: string[] = [];
        await commands.get("aws-login")!.handler("", { ui: { notify: (text: string) => notices.push(text) } });
        const text = notices.join("\n");
        assert.match(text, /missing is not in aws configure list-profiles/);
        assert.match(text, /\/login → Sign in with an API key → Amazon Bedrock \(jig-bedrock\)/);
        assert.doesNotMatch(text, /Restoring AWS SSO/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("/aws-login refuses a profile that is not an SSO profile", async () => {
    const { dir, env } = folder();
    try {
        const { commands } = await build({ env: { ...env, JIG_BEDROCK_PROFILE: "keys" }, list: ["keys"] });
        const notices: string[] = [];
        await commands.get("aws-login")!.handler("", { ui: { notify: (text: string) => notices.push(text) } });
        const text = notices.join("\n");
        assert.match(text, /keys is not an IAM Identity Center \(SSO\) profile/);
        assert.doesNotMatch(text, /Restoring AWS SSO/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
