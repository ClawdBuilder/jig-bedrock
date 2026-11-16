// The login flow and /aws-login as a person meets them: choosing a profile starts discovery before the dialog closes,
// and /aws-login refuses a profile that does not exist or is not an SSO profile instead of starting a doomed sign-in.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
            ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
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
                    if (prompt.message === "Which inference profiles should Bedrock list?") return "system";
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

function fakeAws(dir: string): string {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "aws");
    writeFileSync(
        script,
        `#!/bin/sh
echo "$*" >> "${dir}/aws.log"
case "$*" in
  *--version*) echo "aws-cli/2.34.46 Python/3.12.0 Linux/6.0";;
  *get-caller-identity*) echo '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/fixture"}';;
  *list-inference-profiles*) echo '{"inferenceProfileSummaries":[{"inferenceProfileArn":"arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5","inferenceProfileName":"System Sonnet","status":"ACTIVE","models":[{"modelArn":"arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5"}]}]}' ;;
  *resourcegroupstaggingapi*) echo '{"ResourceTagMappingList":[{"ResourceARN":"arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/team-app","Tags":[{"Key":"Team","Value":"fixture-team"}]}]}' ;;
  *application-inference-profile/team-app*) echo '{"inferenceProfileArn":"arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/team-app","inferenceProfileName":"Team Sonnet","status":"ACTIVE","models":[{"modelArn":"arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5"}]}' ;;
  *) echo '{}';;
esac`,
        { mode: 0o755 },
    );
    return bin;
}

async function loginWithDiscovery(
    discovery: "tag" | "explicit",
): Promise<{ models: string[]; catalogs: Array<Record<string, unknown>> }> {
    const { dir, env } = folder();
    const bin = fakeAws(dir);
    const cache = join(dir, "cache");
    const { provider } = await build({
        env: {
            ...env,
            PATH: `${bin}:${process.env.PATH}`,
            XDG_CACHE_HOME: cache,
            JIG_BEDROCK_PROFILE: undefined,
        },
        list: ["work"],
    });
    const notices: string[] = [];
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
        await provider.auth.apiKey.login({
            signal: new AbortController().signal,
            prompt: async (prompt: any) => {
                if (prompt.type !== "select") {
                    if (prompt.message === "Tag key") return "Team";
                    if (prompt.message === "Tag value") return "fixture-team";
                    if (prompt.message === "Profile ARNs or ids (comma separated)")
                        return "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/team-app";
                    return "";
                }
                if (prompt.message?.includes("How do you sign in to AWS?")) return "existing";
                if (prompt.message === "Which inference profiles should Bedrock list?") return discovery;
                return "profile:work";
            },
            notify: (event: any) => notices.push(event.message ?? ""),
        });
    } finally {
        process.env.PATH = oldPath;
    }
    const catalogs = readdirSync(dir, { recursive: true })
        .filter(
            (name): name is string => typeof name === "string" && name.includes("catalog-") && name.endsWith(".json"),
        )
        .map((name) => JSON.parse(readFileSync(join(dir, String(name)), "utf8")) as Record<string, unknown>);
    return { models: provider.getModels?.().map((model: { id: string }) => model.id) ?? [], catalogs };
}

test("/login choosing by tag applies the tag discovery before the first refresh", async () => {
    const { catalogs } = await loginWithDiscovery("tag");
    assert.equal(catalogs[0]?.mode, "tag");
    const savedProfiles = catalogs[0]?.profiles as Array<{ kind?: string }> | undefined;
    assert.ok(savedProfiles?.length, JSON.stringify(catalogs));
    assert.ok(
        savedProfiles.every((profile) => profile.kind === "application"),
        JSON.stringify(catalogs),
    );
});

test("/login choosing a hand-written list applies explicit discovery before the first refresh", async () => {
    const { catalogs } = await loginWithDiscovery("explicit");
    assert.equal(catalogs[0]?.mode, "explicit");
    const savedProfiles = catalogs[0]?.profiles as Array<{ kind?: string }> | undefined;
    assert.ok(savedProfiles?.length, JSON.stringify(catalogs));
    assert.ok(
        savedProfiles.every((profile) => profile.kind === "application"),
        JSON.stringify(catalogs),
    );
});
