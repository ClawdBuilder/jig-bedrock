// A credential failure on the Messages route is named as one. Pi's Anthropic client turns a thrown fetch into
// "Connection error." and loses the words, so the stream says the credential problem first, and the doctor's request
// verdict points at the keys or role instead of asking for the same call again.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { fakeAwsHttp } from "./support/fake-aws-http.ts";

const account = "123456789012";

async function start(t: test.TestContext) {
    const fake = fakeAwsHttp({
        profiles: [
            {
                arn: `arn:aws:bedrock:us-east-1:${account}:application-inference-profile/team-app`,
                name: "team-app",
                region: "us-east-1",
                foundation: "anthropic.claude-sonnet-5-5",
                tags: { Team: "fixture", Active: "true" },
                kind: "application",
            },
        ],
    });
    const dir = mkdtempSync(join(tmpdir(), "bedrock-credential-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const agent = join(dir, "agent");
    const bin = join(dir, "bin");
    mkdirSync(agent, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
        join(bin, "aws"),
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "aws-cli/2.34.46 Python/3.12"; exit 0; fi\nexit 1\n',
        { mode: 0o755 },
    );
    const env = {
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        XDG_CACHE_HOME: join(dir, "cache"),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        LANG: "C.UTF-8",
    };
    const providers: unknown[] = [];
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
        on(name: string, hook: (event: unknown, ctx: unknown) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: unknown) {
            providers.push(provider);
        },
        registerCommand(name: string, value: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            commands.set(name, value);
        },
        events: { emit() {} },
        setModel: async () => true,
    };
    const handle = (await createBedrockProvider({
        env,
        config: {
            profile: "fixture",
            team: "fixture",
            tagKey: "Team",
            tagValue: "fixture",
            activeTagKey: "Active",
            activeTagValue: "true",
            regions: ["us-east-1"],
            agentDir: agent,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        fetch: fake.fetch,
        // The Messages route signs every request with these; the chain answers with nothing.
        credentials: async () => {
            throw new Error("Could not load credentials from any providers");
        },
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "fixture-secret" }),
        verifyProfile: async () => ({ ok: true }),
        check: async () => ({
            node: { status: "ready", version: "22.19.0" },
            aws: { status: "ready", version: "2.34.46" },
            platform: "linux",
        }),
        backgroundRefresh: false,
    } as never)(pi as never)) as {
        models: Array<{ id: string; provider?: string }>;
        refresh: (force?: boolean) => Promise<unknown>;
    };
    const notices: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        model: undefined as unknown,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: { find: () => undefined },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    await handle.refresh(true);
    const model = handle.models[0];
    assert.ok(model, "the fake AWS loaded one model");
    ctx.model = { ...model, provider: "jig-bedrock" };
    const provider = providers.at(-1) as {
        streamSimple: (
            model: unknown,
            context: unknown,
            options: unknown,
        ) => AsyncIterable<{ type: string; error?: { errorMessage?: string } }>;
    };
    return { commands, ctx, model, notices, provider };
}

test("a credential failure leads with the credential problem, not a connection error", async (t) => {
    const s = await start(t);
    const events: Array<{ type: string; error?: { errorMessage?: string } }> = [];
    for await (const event of s.provider.streamSimple(
        { ...s.model, provider: "jig-bedrock" },
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        {},
    ))
        events.push(event);
    const failure = events.find((event) => event.type === "error");
    assert.ok(failure?.error !== undefined, JSON.stringify(events));
    const message = failure.error.errorMessage ?? "";
    const first = message.split("\n")[0] ?? "";
    assert.doesNotMatch(first, /^Connection error/, message);
    assert.match(
        first,
        /^AWS credentials for the AWS profile fixture could not be loaded: Could not load credentials from any providers\. /,
        message,
    );
    assert.match(first, /aws sts get-caller-identity --profile fixture/, message);
});

test("the doctor's failed request points at the keys and role, not the same call again", async (t) => {
    const s = await start(t);
    const command = s.commands.get("bedrock");
    assert.ok(command, "the doctor command is registered");
    await command.handler("doctor call", s.ctx);
    const text = s.notices.join("\n");
    assert.match(text, /Request: AWS credentials for the AWS profile fixture could not be loaded/, text);
    assert.match(
        text,
        /Next: check the keys or role for fixture with "aws sts get-caller-identity --profile fixture", or refresh the keys/,
        text,
    );
    assert.doesNotMatch(text, /fix the request failure above/, text);
});
