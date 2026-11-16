// A provider whose Messages request is refused by AWS, for the selection guard and the refusal store.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Catalog, filterHash } from "../../src/catalog.ts";
import { createBedrockProvider } from "../../src/provider.ts";

const account = "123456789012";
const arn = `arn:aws:bedrock:us-east-1:${account}:application-inference-profile/team-opus`;
export const refusal = `AccessDeniedException: User: arn:aws:sts::${account}:assumed-role/ExampleRole/user is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: ${arn} because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action`;
const catalog: Catalog = {
    schema: 1,
    mode: "tag",
    aws_profile: "fixture",
    account_id: account,
    regions: ["us-east-1"],
    fetched_at: Math.floor(Date.now() / 1000),
    filter_hash: filterHash({ mode: "tag", tagKey: "Team", tagValue: "fixture" }),
    profiles: [
        {
            arn,
            profile_name: "team-opus",
            foundation_model_id: "anthropic.claude-opus-5",
            region: "us-east-1",
            kind: "application",
        },
    ],
};

export async function startRefusalProvider(t: test.TestContext, options: { unwritable?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-refusal-provider-"));
    const cache = join(dir, "cache");
    t.after(() => {
        if (options.unwritable === true) chmodSync(cache, 0o700);
        rmSync(dir, { recursive: true, force: true });
    });
    if (options.unwritable === true) {
        mkdirSync(cache, { recursive: true, mode: 0o500 });
        chmodSync(cache, 0o500);
    }
    const env = { HOME: dir, PI_CODING_AGENT_DIR: dir, XDG_CACHE_HOME: cache };
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const providers: any[] = [];
    const pi = {
        on(name: string, hook: (event: any, ctx: any) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand() {},
        events: { emit() {} },
        setModel: async () => true,
    };
    const handle = await createBedrockProvider({
        env,
        config: {
            profile: "fixture",
            team: "fixture",
            tagKey: "Team",
            tagValue: "fixture",
            regions: ["us-east-1"],
            messagesModels: ["claude-opus-5"],
            agentDir: dir,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: { load: () => catalog, refresh: async () => "ok" },
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        credentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" }),
        fetch: async () =>
            new Response(JSON.stringify({ message: refusal }), {
                status: 403,
                headers: { "content-type": "application/json" },
            }),
        backgroundRefresh: false,
    } as never)(pi as never);
    assert.ok(handle);
    const notices: string[] = [];
    let editor = "";
    const ctx = {
        hasUI: true,
        mode: "tui",
        signal: new AbortController().signal,
        model: undefined,
        ui: {
            notify: (text: string) => notices.push(text),
            setEditorText: (text: string) => {
                editor = text;
            },
            setStatus() {},
        },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: { find: () => undefined },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    const provider = providers.at(-1);
    const model = provider.getModels?.()[0];
    assert.ok(model, "the catalog model is registered");
    ctx.model = model as never;
    return { dir, env, hooks, providers, provider, model, ctx, notices, editor: () => editor };
}

export async function refusalEvents(provider: any, model: any): Promise<any[]> {
    const events: any[] = [];
    for await (const event of provider.streamSimple(
        { ...model, provider: "jig-bedrock" },
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        {},
    ))
        events.push(event);
    return events;
}
