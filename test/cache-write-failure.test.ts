import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBedrockProvider } from "../src/provider.ts";
import { type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const account = "123456789012";
const profile = (name: string): FakeAwsProfile => ({
    arn: `arn:aws:bedrock:us-east-1:${account}:application-inference-profile/${name}`,
    name,
    region: "us-east-1",
    foundation: "anthropic.claude-sonnet-5-5",
    tags: { Team: "fixture", Active: "true" },
    kind: "application",
});

test("models load from memory when the cache folder cannot be written, and the warning is said once", {
    skip: process.platform === "win32" ? "the cache folder permissions are a POSIX test" : false,
}, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-cache-write-"));
    t.after(() => {
        chmodSync(join(dir, "cache"), 0o700);
        rmSync(dir, { recursive: true, force: true });
    });
    const agent = join(dir, "agent");
    const bin = join(dir, "bin");
    const cache = join(dir, "cache");
    mkdirSync(agent, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(cache, { recursive: true, mode: 0o500 });
    chmodSync(cache, 0o500);
    writeFileSync(
        join(bin, "aws"),
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "aws-cli/2.34.46 Python/3.12"; exit 0; fi\nexit 1\n',
        { mode: 0o755 },
    );
    const env = {
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        XDG_CACHE_HOME: cache,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        LANG: "C.UTF-8",
    };
    const fake = fakeAwsHttp({ profiles: [profile("a"), profile("b")] });
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, any>();
    const providers: any[] = [];
    const pi = {
        on(name: string, hook: (event: any, ctx: any) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider(provider: any) {
            providers.push(provider);
        },
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
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
            activeTagKey: "Active",
            activeTagValue: "true",
            regions: ["us-east-1"],
            agentDir: agent,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: undefined,
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        fetch: fake.fetch,
        discoveryCredentials: async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" }),
        verifyProfile: async () => ({ ok: true }),
        backgroundRefresh: true,
    } as never)(pi as never);
    const notices: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        model: undefined,
        ui: { notify: (text: string) => notices.push(text), setStatus() {} },
        sessionManager: { getSessionId: () => "s", getBranch: () => [] },
        modelRegistry: { find: () => undefined },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);

    assert.equal(await handle.refresh(true), "ok");
    assert.equal(providers.at(-1)?.getModels?.().length, 2);
    const first = notices.join("\n");
    assert.match(first, /Could not save the model list in ~\/cache\/jig-bedrock/);
    assert.match(first, /EACCES|permission denied/);
    assert.match(first, /next start reads AWS again/);

    notices.length = 0;
    await handle.refresh(true);
    assert.doesNotMatch(notices.join("\n"), /Could not save the model list/);

    notices.length = 0;
    const command = commands.get("bedrock");
    assert.ok(command);
    await command.handler("doctor", ctx);
    const doctorText = notices.join("\n");
    assert.match(doctorText, /! Could not save the model list in ~\/cache\/jig-bedrock/);
    assert.match(doctorText, /Next: check the folder's permissions/);
    assert.doesNotMatch(doctorText, /Setup looks right/);
});
