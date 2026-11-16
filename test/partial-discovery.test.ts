import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Status } from "../src/aws-discovery.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { bedrockFailure, type FakeAwsFailure, type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const account = "123456789012";
const arn = (name: string) => `arn:aws:bedrock:us-east-1:${account}:application-inference-profile/${name}`;
const application = (name: string): FakeAwsProfile => ({
    arn: arn(name),
    name,
    region: "us-east-1",
    foundation: "anthropic.claude-sonnet-5-5",
    tags: { Team: "fixture", Active: "true" },
    kind: "application",
});
const system = (region: string): FakeAwsProfile => ({
    arn: `arn:aws:bedrock:${region}::inference-profile/global.anthropic.claude-sonnet-5-5`,
    name: "System Sonnet",
    region,
    foundation: "anthropic.claude-sonnet-5-5",
    tags: {},
    kind: "system",
});

async function start(t: test.TestContext, fake: ReturnType<typeof fakeAwsHttp>, config: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-partial-discovery-"));
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
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, any>();
    const pi = {
        on(name: string, hook: (event: any, ctx: any) => unknown) {
            hooks.set(name, [...(hooks.get(name) ?? []), hook]);
        },
        registerProvider() {},
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
            ...config,
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
    return { dir, env, commands, notices, ctx, handle };
}

async function advice(
    t: test.TestContext,
    fake: ReturnType<typeof fakeAwsHttp>,
    config: Record<string, unknown>,
    status: Status,
) {
    const s = await start(t, fake, config);
    assert.equal(await s.handle.refresh(true), status);
    const startText = s.notices.join("\n");
    const command = s.commands.get("bedrock");
    assert.ok(command);
    s.notices.length = 0;
    await command.handler("refresh", s.ctx);
    const refreshText = s.notices.join("\n");
    s.notices.length = 0;
    await command.handler("doctor", s.ctx);
    const doctorText = s.notices.join("\n");
    return { startText, refreshText, doctorText };
}

for (const entry of [
    {
        name: "a missing profile",
        cause: "AWS has no inference profile with that ARN in this region",
        failure: (): FakeAwsFailure => bedrockFailure("ResourceNotFoundException", "The resource was not found.", 404),
    },
    {
        name: "a throttled profile",
        cause: "AWS is limiting requests",
        failure: (): FakeAwsFailure => bedrockFailure("ThrottlingException", "Please retry."),
    },
]) {
    test(`an explicit list with ${entry.name} says what loaded and what failed`, async (t) => {
        const fake = fakeAwsHttp({
            profiles: [application("team-a")],
            fail: (operation, _region, request): FakeAwsFailure | undefined =>
                operation === "get" && request.url.includes("team-b") ? entry.failure() : undefined,
        });
        const { startText, refreshText, doctorText } = await advice(
            t,
            fake,
            { mode: "explicit", profiles: [arn("team-a"), arn("team-b")], regions: ["us-east-1"] },
            "ok",
        );
        for (const text of [startText, refreshText, doctorText]) {
            assert.match(text, /1 of 2 inference profiles loaded/);
            assert.match(text, new RegExp(entry.cause));
            assert.doesNotMatch(text, /unexpected answer/);
        }
        assert.match(doctorText, /! Models: 1 of 2 inference profiles loaded/);
        assert.doesNotMatch(doctorText, /Access denied for inference profile/);
        assert.doesNotMatch(doctorText, /ask your AWS administrator/);
        assert.match(refreshText, /Next: check the failed profile or region/);
    });
}

test("a region that did not answer is named beside the models that did", async (t) => {
    const fake = fakeAwsHttp({
        profiles: [system("us-east-1"), system("eu-west-1")],
        fail: (operation, region) =>
            operation === "list" && region === "eu-west-1"
                ? bedrockFailure("InternalServerException", "The service had a problem.", 500)
                : undefined,
    });
    const { startText, refreshText, doctorText } = await advice(
        t,
        fake,
        { mode: "system", regions: ["us-east-1", "eu-west-1"] },
        "ok",
    );
    for (const text of [startText, refreshText, doctorText]) {
        assert.match(text, /1 model loaded from 1 of 2 regions/);
        assert.match(text, /eu-west-1 did not answer: AWS had a problem on its side/);
        assert.doesNotMatch(text, /2 found in us-east-1, eu-west-1/);
    }
    assert.match(doctorText, /! Models: 1 model loaded from 1 of 2 regions/);
});

for (const [name, failureType, cause, permission] of [
    [
        "a missing profile",
        () => bedrockFailure("ResourceNotFoundException", "The resource was not found.", 404),
        "AWS has no inference profile with that ARN in this region",
        false,
    ],
    [
        "a refused profile",
        () => bedrockFailure("AccessDeniedException", "The request was denied.", 403),
        "AWS denied access",
        true,
    ],
] as const) {
    test(`an explicit list where every profile fails with ${name} names the cause, not Access denied`, async (t) => {
        const fake = fakeAwsHttp({
            profiles: [],
            fail: (operation) => (operation === "get" ? failureType() : undefined),
        });
        const { doctorText, refreshText } = await advice(
            t,
            fake,
            { mode: "explicit", profiles: [arn("team-a"), arn("team-b")], regions: ["us-east-1"] },
            "unavailable",
        );
        for (const text of [doctorText, refreshText]) {
            assert.match(text, new RegExp(cause));
            assert.doesNotMatch(text, /Access denied for inference profile/);
            assert.doesNotMatch(text, /unexpected answer/);
        }
        if (permission) assert.match(doctorText, /Next: Ask your AWS administrator for bedrock:GetInferenceProfile/);
        else assert.doesNotMatch(doctorText, /Ask your AWS administrator/);
    });
}
