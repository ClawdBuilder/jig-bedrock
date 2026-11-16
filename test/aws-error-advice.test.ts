import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Status } from "../src/aws-discovery.ts";
import { createBedrockProvider } from "../src/provider.ts";
import { bedrockFailure, type FakeAwsFailure, type FakeAwsProfile, fakeAwsHttp } from "./support/fake-aws-http.ts";

const account = "123456789012";
const profile = (region = "us-east-1"): FakeAwsProfile => ({
    arn: `arn:aws:bedrock:${region}:${account}:application-inference-profile/team-${region}`,
    name: `team-${region}`,
    region,
    foundation: "anthropic.claude-sonnet-5-5",
    tags: { Team: "fixture", Active: "true" },
    kind: "application",
});
const jsonError = (type: string, message: string) => JSON.stringify({ __type: type, message });
const xmlError = (code: string, message: string) =>
    `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`;

async function start(
    t: test.TestContext,
    fake: ReturnType<typeof fakeAwsHttp>,
    options: {
        regions?: string[];
        credentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
        sso?: boolean;
    } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-aws-error-"));
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
    if (options.sso === true) {
        mkdirSync(join(dir, ".aws"), { recursive: true });
        writeFileSync(
            join(dir, ".aws", "config"),
            "[profile fixture]\nsso_session = s\n[sso-session s]\nsso_region = us-east-1\nsso_start_url = https://example.awsapps.com/start\n",
        );
    }
    const env = {
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        XDG_CACHE_HOME: join(dir, "cache"),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        LANG: "C.UTF-8",
    };
    const providers: any[] = [];
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, any>();
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
            regions: options.regions ?? ["us-east-1"],
            agentDir: agent,
            ssoLoginCommand: [],
            signInAtStart: false,
        },
        catalog: undefined,
        listProfiles: async () => ["fixture"],
        ssoRecover: async () => {},
        fetch: fake.fetch,
        discoveryCredentials:
            options.credentials ?? (async () => ({ accessKeyId: "AKIAFIXTURE", secretAccessKey: "secret" })),
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
    return { dir, env, providers, commands, notices, ctx, handle };
}

interface Case {
    name: string;
    fail?: (
        operation: "sts" | "tagging" | "list" | "get",
        region: string,
        request: { url: string; body: string },
    ) => FakeAwsFailure | undefined;
    credentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
    status: Status;
    start: RegExp[];
    refresh: RegExp[];
    doctor: RegExp[];
    never: RegExp[];
}

const cases: Case[] = [
    {
        name: "Throttling",
        fail: (operation) =>
            operation === "tagging"
                ? { status: 429, body: jsonError("ThrottlingException", "Rate exceeded") }
                : undefined,
        status: "throttled",
        start: [/AWS is limiting requests/, /wait a minute/],
        refresh: [/Next: AWS is limiting requests; wait a minute/, /\/bedrock refresh/],
        doctor: [/Models: .*AWS is limiting requests/, /Next: AWS is limiting requests/],
        never: [/docs\/settings/, /administrator/],
    },
    {
        name: "An AWS server error",
        fail: (operation) =>
            operation === "tagging"
                ? { status: 500, body: jsonError("InternalServerException", "An internal error occurred") }
                : undefined,
        status: "aws_error",
        start: [/AWS had a problem on its side/, /try again later/],
        refresh: [/Next: AWS had a problem on its side; try again later/],
        doctor: [/Models: .*AWS had a problem on its side/, /Next: AWS had a problem on its side/],
        never: [/docs\/settings/, /administrator/],
    },
    {
        name: "An AWS service outage",
        fail: (operation) => (operation === "tagging" ? { status: 503, body: "" } : undefined),
        status: "aws_error",
        start: [/AWS had a problem on its side/, /try again later/],
        refresh: [/Next: AWS had a problem on its side; try again later/],
        doctor: [/Models: .*AWS had a problem on its side/, /Next: AWS had a problem on its side/],
        never: [/docs\/settings/, /administrator/],
    },
    {
        name: "Expired temporary credentials",
        fail: (operation) =>
            operation === "sts"
                ? {
                      status: 403,
                      body: xmlError("ExpiredToken", "The security token included in the request is expired"),
                  }
                : undefined,
        status: "expired_credentials",
        start: [/AWS credentials .* have expired/, /Refresh the keys/],
        refresh: [/Next: Renew the AWS sign-in/, /\/bedrock login/, /keys/],
        doctor: [/Models: .*credentials have expired/, /Next: Renew the AWS sign-in/, /\/bedrock login/],
        never: [/unexpected answer/, /docs\/settings/],
    },
    {
        name: "Revoked or wrong keys",
        fail: (operation) =>
            operation === "sts"
                ? {
                      status: 403,
                      body: xmlError("InvalidClientTokenId", "The security token included in the request is invalid."),
                  }
                : undefined,
        status: "invalid_credentials",
        start: [/keys .* are not valid/, /revoked or wrong/, /region may not be enabled/],
        refresh: [/Next: The AWS keys are not valid/, /region may not be enabled/],
        doctor: [/Models: .*credentials are not valid/, /Next: The AWS keys are not valid/],
        never: [/ListInferenceProfiles/, /administrator/],
    },
    {
        name: "A Bedrock access denial",
        fail: (operation) =>
            operation === "get" ? bedrockFailure("AccessDeniedException", "The request was denied.", 403) : undefined,
        status: "unavailable",
        start: [/Could not read team-us-east-1: AWS denied access/],
        refresh: [/Could not read team-us-east-1: AWS denied access/],
        doctor: [/Models: .*AWS denied access/],
        never: [/unexpected answer/],
    },
    {
        name: "Bedrock throttling",
        fail: (operation) => (operation === "get" ? bedrockFailure("ThrottlingException", "Please retry.") : undefined),
        status: "unavailable",
        start: [/Could not read team-us-east-1: AWS is limiting requests/],
        refresh: [/Could not read team-us-east-1: AWS is limiting requests/],
        doctor: [/Models: .*AWS is limiting requests/],
        never: [/unexpected answer/],
    },
    {
        name: "Bedrock invalid keys",
        fail: (operation) =>
            operation === "get"
                ? bedrockFailure("UnrecognizedClientException", "The request is not valid.", 403)
                : undefined,
        status: "unavailable",
        start: [/Could not read team-us-east-1: .*credentials are not valid/],
        refresh: [/Could not read team-us-east-1: .*credentials are not valid/],
        doctor: [/Models: .*credentials are not valid/],
        never: [/unexpected answer/],
    },
    {
        name: "a missing Bedrock profile",
        fail: (operation) =>
            operation === "get"
                ? bedrockFailure("ResourceNotFoundException", "The resource was not found.", 404)
                : undefined,
        status: "unavailable",
        start: [/Could not read team-us-east-1: AWS has no inference profile/],
        refresh: [/Could not read team-us-east-1: AWS has no inference profile/],
        doctor: [/Models: .*AWS has no inference profile/],
        never: [/unexpected answer/],
    },
    {
        name: "An expired SSO sign-in",
        credentials: async () => {
            throw new Error(
                "The SSO session associated with this profile has expired or is otherwise invalid. Run aws sso login with the corresponding profile.",
            );
        },
        status: "sso_expired",
        start: [/sign-in expired/],
        refresh: [/Next: Run \/bedrock login/],
        doctor: [/Models: .*your sign-in has expired/, /Next: Run \/bedrock login/],
        never: [/unexpected answer/],
    },
];

for (const c of cases) {
    test(`${c.name} gets advice for its real cause`, async (t) => {
        const fake = fakeAwsHttp({ profiles: [profile()], ...(c.fail === undefined ? {} : { fail: c.fail }) });
        const s = await start(t, fake, c.credentials === undefined ? {} : { credentials: c.credentials });
        assert.equal(await s.handle.refresh(true), c.status);
        const startText = s.notices.join("\n");
        for (const pattern of c.start) assert.match(startText, pattern, startText);
        for (const pattern of c.never) assert.doesNotMatch(startText, pattern, startText);

        const command = s.commands.get("bedrock");
        assert.ok(command);
        s.notices.length = 0;
        await command.handler("refresh", s.ctx);
        const refreshText = s.notices.join("\n");
        for (const pattern of c.refresh) assert.match(refreshText, pattern, refreshText);
        for (const pattern of c.never) assert.doesNotMatch(refreshText, pattern, refreshText);

        s.notices.length = 0;
        await command.handler("doctor", s.ctx);
        const doctorText = s.notices.join("\n");
        for (const pattern of c.doctor) assert.match(doctorText, pattern, doctorText);
        for (const pattern of c.never) assert.doesNotMatch(doctorText, pattern, doctorText);
    });
}

test("expired credentials for an SSO profile ask for /bedrock login", async (t) => {
    const fake = fakeAwsHttp({
        profiles: [profile()],
        fail: (operation) =>
            operation === "sts"
                ? {
                      status: 403,
                      body: xmlError("ExpiredToken", "The security token included in the request is expired"),
                  }
                : undefined,
    });
    const s = await start(t, fake, { sso: true });
    assert.equal(await s.handle.refresh(true), "expired_credentials");
    const text = s.notices.join("\n");
    assert.match(text, /sign-in expired/);
    assert.match(text, /\/bedrock login/);
});

for (const c of [
    {
        name: "throttling",
        fail: (operation: "sts" | "tagging" | "list" | "get") =>
            operation === "tagging"
                ? { status: 429, body: jsonError("ThrottlingException", "Rate exceeded") }
                : undefined,
        text: /eu-west-1 did not answer: AWS is limiting requests; try again in a minute/,
    },
    {
        name: "an AWS server error",
        fail: (operation: "sts" | "tagging" | "list" | "get") =>
            operation === "tagging"
                ? { status: 500, body: jsonError("InternalServerException", "An internal error occurred") }
                : undefined,
        text: /eu-west-1 did not answer: AWS had a problem on its side; try again later/,
    },
    {
        name: "expired credentials",
        fail: (operation: "sts" | "tagging" | "list" | "get") =>
            operation === "tagging"
                ? {
                      status: 403,
                      body: jsonError("ExpiredToken", "The security token included in the request is expired"),
                  }
                : undefined,
        text: /eu-west-1 did not answer: the AWS credentials have expired/,
    },
    {
        name: "invalid keys",
        fail: (operation: "sts" | "tagging" | "list" | "get") =>
            operation === "tagging"
                ? {
                      status: 403,
                      body: jsonError("InvalidClientTokenId", "The security token included in the request is invalid."),
                  }
                : undefined,
        text: /eu-west-1 did not answer: the AWS credentials are not valid there; .*region may not be enabled/,
    },
]) {
    test(`a region with ${c.name} is named in the start notice, refresh and doctor`, async (t) => {
        const fake = fakeAwsHttp({
            profiles: [profile("us-east-1"), profile("eu-west-1")],
            fail: (operation, region) => (region === "eu-west-1" ? c.fail(operation) : undefined),
        });
        const s = await start(t, fake, { regions: ["us-east-1", "eu-west-1"] });
        await s.handle.refresh(false);
        const startText = s.notices.join("\n");
        assert.match(startText, c.text, startText);
        assert.doesNotMatch(startText, /docs\/settings/, startText);

        const command = s.commands.get("bedrock");
        assert.ok(command);
        s.notices.length = 0;
        await command.handler("refresh", s.ctx);
        assert.match(s.notices.join("\n"), c.text, s.notices.join("\n"));

        s.notices.length = 0;
        await command.handler("doctor", s.ctx);
        assert.match(s.notices.join("\n"), c.text, s.notices.join("\n"));
    });
}
