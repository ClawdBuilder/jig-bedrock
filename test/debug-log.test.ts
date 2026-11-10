// The debug log: off by default and then it writes nothing and makes nothing; on, one line per request (both routes),
// discovery run and sign-in repair, with no account id, ARN, credential or prompt in it, private, and rotated at a size.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { createSignedFetch } from "../src/bedrock-fetch.ts";
import type { BedrockModel, Catalog, Profile } from "../src/catalog.ts";
import { bedrockStream, discoveredProfiles, usePiAnthropicRegistry, usePiRegistry } from "../src/catalog.ts";
import { loadConfig, validateBedrock } from "../src/config.ts";
import {
    createDebugLog,
    debugEnabled,
    debugLogPath,
    redact,
    withDebugCatalog,
    withDebugLog,
    withDebugRecover,
} from "../src/debug-log.ts";
import { JIG_BEDROCK } from "../src/identity.ts";
import { SsoRecoveryError } from "../src/sso.ts";
import { hostImport } from "./support/pi-host.ts";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const APP = `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/orders-api`;

function state(t: test.TestContext): { env: NodeJS.ProcessEnv; folder: string } {
    const root = mkdtempSync(join(tmpdir(), "jig-bedrock-debug-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { env: { XDG_STATE_HOME: join(root, "state"), HOME: root }, folder: join(root, "state", "jig-bedrock") };
}

const lines = (env: NodeJS.ProcessEnv): Array<Record<string, unknown>> =>
    readFileSync(debugLogPath(env), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

async function registries(): Promise<{ anthropic: Provider; bedrock: Provider }> {
    const { builtinProviders } = await hostImport("@earendil-works/pi-ai/providers/all");
    await usePiAnthropicRegistry();
    const find = (id: string) => builtinProviders().find((provider: { id: string }) => provider.id === id) as Provider;
    usePiRegistry(find("amazon-bedrock"));
    return { anthropic: find("anthropic"), bedrock: find("amazon-bedrock") };
}

function catalogOf(foundation: string): Catalog {
    const profile: Profile = {
        arn: APP,
        profile_name: "Orders API",
        foundation_model_id: foundation,
        region: REGION,
        kind: "application",
    };
    return {
        schema: 1,
        aws_profile: "my-profile",
        account_id: ACCOUNT,
        regions: [REGION],
        fetched_at: Math.floor(Date.now() / 1000),
        profiles: [profile],
    };
}

const SSE = [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":30,"output_tokens":1,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a private reply"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
    "",
].join("\n");

const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-canary", sessionToken: "token-canary" };

test("off by default: nothing is written and no file or folder is made", (t) => {
    const { env, folder } = state(t);
    assert.equal(debugEnabled(env, {}), false);
    const log = createDebugLog({ enabled: debugEnabled(env, {}), env });
    log.write({ event: "request" });
    assert.equal(existsSync(folder), false);
    const recovered = { provider: {} } as never;
    assert.equal(withDebugLog(recovered, log), recovered, "the streams are returned untouched");
    const catalog = { load: () => undefined, refresh: async () => "ok" as const };
    assert.equal(
        withDebugCatalog(catalog, log, () => ({ regions: [] })),
        catalog,
    );
    const recover = async () => {};
    assert.equal(withDebugRecover(recover, log), recover);
});

test("on with JIG_BEDROCK_DEBUG=1 or the debug setting, and the setting is checked", () => {
    assert.equal(debugEnabled({ JIG_BEDROCK_DEBUG: "1" }, {}), true);
    assert.equal(debugEnabled({ JIG_BEDROCK_DEBUG: "0" }, {}), false);
    assert.equal(debugEnabled({}, { debug: true }), true);
    assert.equal(loadConfig({ raw: {}, env: {} }).config?.debug, false);
    assert.equal(loadConfig({ raw: { debug: true }, env: {} }).config?.debug, true);
    assert.equal(loadConfig({ raw: {}, env: { JIG_BEDROCK_DEBUG: "1" } }).config?.debug, true);
    assert.deepEqual(validateBedrock({ debug: "yes" }), ["bedrock.debug must be true or false"]);
    assert.deepEqual(validateBedrock({ debug: false }), []);
});

test("the log path follows XDG_STATE_HOME, else ~/.local/state", () => {
    assert.equal(debugLogPath({ XDG_STATE_HOME: "/state", HOME: "/home/a" }), "/state/jig-bedrock/debug.log");
    assert.equal(debugLogPath({ HOME: "/home/a" }), "/home/a/.local/state/jig-bedrock/debug.log");
});

test("redact: an account id becomes <account>, a full ARN its last path segment, a secret goes", () => {
    assert.equal(redact(APP), "orders-api");
    assert.equal(
        redact(
            `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/us.anthropic.claude-haiku-5-5-v1:0 is not allowed`,
        ),
        "us.anthropic.claude-haiku-5-5-v1:0 is not allowed",
    );
    assert.equal(
        redact(`User: arn:aws:sts::${ACCOUNT}:assumed-role/Dev/me is not authorized`),
        "User: me is not authorized",
    );
    assert.equal(redact(`arn:aws:iam::${ACCOUNT}:root`), "root");
    assert.equal(redact(`account ${ACCOUNT} and ${ACCOUNT}.`), "account <account> and <account>.");
    assert.equal(
        redact("a 13-digit number 1234567890123 and 12345678901 stay"),
        "a 13-digit number 1234567890123 and 12345678901 stay",
    );
    assert.equal(
        redact(
            `The request signature: Credential=AKIDEXAMPLE/20261110/us-east-1/bedrock/aws4_request, Signature=0a1b2c`,
        ),
        "The request signature: Credential=<redacted>, Signature=<redacted>",
    );
    assert.equal(redact(`key ${"AKIA"}ABCDEFGHIJKLMNOP and Bearer abc.def-ghi`), "key <key> and Bearer <redacted>");
    assert.equal(redact("nothing to hide"), "nothing to hide");
    for (const text of [APP, `ARN ${APP} in account ${ACCOUNT}`, `arn:aws:bedrock:${REGION}:${ACCOUNT}:foo`])
        assert.doesNotMatch(redact(text), new RegExp(`${ACCOUNT}|arn:`));
});

test("a Messages reply writes one line with the model, region, route, status, request id, time and tokens", async (t) => {
    const { env } = state(t);
    const { anthropic, bedrock } = await registries();
    const catalog = catalogOf("anthropic.claude-haiku-5-5");
    const [model] = discoveredProfiles(catalog, "").available;
    assert.ok(model);
    const signedFetch = createSignedFetch({
        credentials: async () => CREDENTIALS,
        fetch: (async () =>
            new Response(SSE, {
                status: 200,
                headers: { "content-type": "text/event-stream", "x-amzn-RequestId": "req-ok-1" },
            })) as typeof globalThis.fetch,
    });
    const log = createDebugLog({ enabled: true, env });
    const wrapped = withDebugLog(
        { provider: bedrock, messages: { stream: anthropic.stream, streamSimple: anthropic.streamSimple } },
        log,
    );
    const stream = bedrockStream(
        [model],
        { converse: () => assert.fail("no Converse call"), messages: wrapped.messages?.streamSimple },
        () => catalog,
        () => "my-profile",
        signedFetch,
    );
    let last: { type?: string } | undefined;
    for await (const event of stream(
        { ...model, provider: JIG_BEDROCK },
        { messages: [{ role: "user", content: "a private prompt", timestamp: 1 }] },
        { env: { AWS_PROFILE: "my-profile" } },
    ))
        last = event;
    assert.equal(last?.type, "done", JSON.stringify(last));
    await new Promise((resolve) => setImmediate(resolve));
    const [line, ...rest] = lines(env);
    assert.equal(rest.length, 0, "one line per request");
    assert.ok(line);
    assert.match(String(line.time), /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.equal(line.event, "request");
    assert.equal(line.model, "claude-haiku-5-5");
    assert.equal(line.region, REGION);
    assert.equal(line.route, "messages");
    assert.equal(line.status, 200);
    assert.equal(line.requestId, "req-ok-1");
    assert.equal(typeof line.ms, "number");
    assert.deepEqual(
        { input: line.input, output: line.output, cacheRead: line.cacheRead, cacheWrite: line.cacheWrite },
        { input: 30, output: 7, cacheRead: 20, cacheWrite: 5 },
    );
    assert.equal(line.error, undefined);
    const text = readFileSync(debugLogPath(env), "utf8");
    assert.doesNotMatch(
        text,
        /arn:|123456789012|a private prompt|a private reply|AKIDEXAMPLE|secret-canary|token-canary|authorization/i,
    );
});

test("a failed Messages request writes the AWS error name, a cleaned message and the status", async (t) => {
    const { env } = state(t);
    const { anthropic, bedrock } = await registries();
    const catalog = catalogOf("anthropic.claude-haiku-5-5");
    const [model] = discoveredProfiles(catalog, "").available;
    assert.ok(model);
    const signedFetch = createSignedFetch({
        credentials: async () => CREDENTIALS,
        fetch: (async () =>
            new Response(
                JSON.stringify({
                    type: "error",
                    error: {
                        type: "invalid_request_error",
                        message: `The provided model identifier is invalid: ${APP} (account ${ACCOUNT}). ${"x".repeat(400)}`,
                    },
                }),
                {
                    status: 400,
                    headers: {
                        "content-type": "application/json",
                        "x-amzn-requestid": "req-bad-1",
                        "x-amzn-errortype": "ValidationException:http://internal.amazon.com/coral/",
                    },
                },
            )) as typeof globalThis.fetch,
    });
    const log = createDebugLog({ enabled: true, env });
    const wrapped = withDebugLog(
        { provider: bedrock, messages: { stream: anthropic.stream, streamSimple: anthropic.streamSimple } },
        log,
    );
    const stream = bedrockStream(
        [model],
        { converse: () => assert.fail("no Converse call"), messages: wrapped.messages?.streamSimple },
        () => catalog,
        () => "my-profile",
        signedFetch,
    );
    let last: { type?: string } | undefined;
    for await (const event of stream(
        { ...model, provider: JIG_BEDROCK },
        { messages: [{ role: "user", content: "a private prompt", timestamp: 1 }] },
        { env: { AWS_PROFILE: "my-profile" } },
    ))
        last = event;
    assert.equal(last?.type, "error");
    await new Promise((resolve) => setImmediate(resolve));
    const [line] = lines(env);
    assert.ok(line);
    assert.equal(line.status, 400);
    assert.equal(line.requestId, "req-bad-1");
    assert.equal(line.error, "ValidationException");
    assert.equal(line.route, "messages");
    assert.equal(line.model, "claude-haiku-5-5");
    assert.equal(line.input, undefined);
    const message = String(line.message);
    assert.ok(message.length <= 300, `the message is cut at 300 characters (${message.length})`);
    assert.doesNotMatch(message, /arn:|123456789012/);
    assert.match(message, /orders-api/);
    assert.doesNotMatch(
        readFileSync(debugLogPath(env), "utf8"),
        /arn:|123456789012|a private prompt|AKIDEXAMPLE|secret-canary|token-canary/i,
    );
});

test("a Converse request that fails at a local HTTP endpoint writes its status, request id and error", async (t) => {
    const { env } = state(t);
    const before = process.env.AWS_BEARER_TOKEN_BEDROCK;
    t.after(() => {
        if (before === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    });
    const server = createServer((request, response) => {
        request.resume();
        response.writeHead(403, {
            "content-type": "application/json",
            "x-amzn-requestid": "req-converse-1",
            "x-amzn-errortype": "AccessDeniedException",
        });
        response.end(`{"message":"User: arn:aws:sts::${ACCOUNT}:assumed-role/Dev/me is not authorized"}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { bedrock } = await registries();
    const catalog = catalogOf("anthropic.claude-haiku-4-5");
    const model: BedrockModel = {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        api: "bedrock-converse-stream",
        baseUrl: `http://127.0.0.1:${address.port}`,
        provider: JIG_BEDROCK,
        arn: APP,
        foundationModelId: "anthropic.claude-haiku-4-5",
        rateSource: "Pi registry",
        aliases: [],
        reasoning: false,
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    };
    const log = createDebugLog({ enabled: true, env });
    const wrapped = withDebugLog({ provider: bedrock }, log);
    const stream = bedrockStream(
        [model],
        { converse: wrapped.provider.streamSimple },
        () => catalog,
        () => undefined,
    );
    const previous = process.env.AWS_BEDROCK_FORCE_HTTP1;
    process.env.AWS_BEDROCK_FORCE_HTTP1 = "1";
    t.after(() => {
        if (previous === undefined) delete process.env.AWS_BEDROCK_FORCE_HTTP1;
        else process.env.AWS_BEDROCK_FORCE_HTTP1 = previous;
    });
    let last: { type?: string } | undefined;
    for await (const event of stream(
        { ...model, provider: JIG_BEDROCK },
        { messages: [{ role: "user", content: "a private prompt", timestamp: 1 }] },
        { env: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret-canary" } },
    ))
        last = event;
    assert.equal(last?.type, "error");
    await new Promise((resolve) => setImmediate(resolve));
    const [line] = lines(env);
    assert.ok(line);
    assert.equal(line.route, "converse");
    assert.equal(line.model, model.id);
    assert.equal(line.status, 403);
    assert.equal(line.requestId, "req-converse-1");
    assert.equal(line.error, "AccessDeniedException");
    assert.doesNotMatch(String(line.message), /arn:|123456789012/);
    assert.doesNotMatch(readFileSync(debugLogPath(env), "utf8"), /a private prompt|AKIDEXAMPLE|secret-canary/);
});

test("a discovery run and a sign-in repair each write a line", async (t) => {
    const { env } = state(t);
    const log = createDebugLog({ enabled: true, env });
    let fetched = 100;
    const catalog = withDebugCatalog(
        {
            load: () => ({ ...catalogOf("anthropic.claude-haiku-5-5"), fetched_at: fetched }),
            refresh: async (force) => {
                if (force) fetched = 200;
                return "ok";
            },
        },
        log,
        () => ({ mode: "system", regions: ["us-east-1", "eu-west-1"] }),
    );
    await catalog.refresh(true);
    await catalog.refresh(false);
    const failing = withDebugCatalog(
        {
            load: () => undefined,
            refresh: async () => "permission_denied",
            failure: () => `Could not list: AccessDenied for arn:aws:iam::${ACCOUNT}:user/me`,
        },
        log,
        () => ({ regions: [REGION] }),
    );
    await failing.refresh(true);
    const ok = withDebugRecover(async () => {}, log);
    await ok("my-profile", undefined, "warmup");
    const bad = withDebugRecover(async () => {
        throw new SsoRecoveryError("timeout");
    }, log);
    await assert.rejects(bad("my-profile", undefined, "request"));
    const [fresh, cached, denied, restored, failed] = lines(env);
    assert.deepEqual(
        {
            event: fresh?.event,
            mode: fresh?.mode,
            regions: fresh?.regions,
            models: fresh?.models,
            status: fresh?.status,
        },
        { event: "discovery", mode: "system", regions: ["us-east-1", "eu-west-1"], models: 1, status: "ok" },
    );
    assert.equal(typeof fresh?.ms, "number");
    assert.equal(fresh?.cached, undefined);
    assert.equal(cached?.cached, true);
    assert.equal(denied?.error, "permission_denied");
    assert.equal(denied?.message, "Could not list: AccessDenied for me");
    assert.deepEqual(
        { event: restored?.event, source: restored?.source, outcome: restored?.outcome },
        { event: "sign-in", source: "warmup", outcome: "restored" },
    );
    assert.deepEqual(
        { source: failed?.source, outcome: failed?.outcome, category: failed?.category },
        { source: "request", outcome: "failed", category: "timeout" },
    );
    assert.doesNotMatch(readFileSync(debugLogPath(env), "utf8"), /my-profile|123456789012|arn:/);
});

test("the file is private (0600, folder 0700) and a failed write never throws", (t) => {
    const { env, folder } = state(t);
    createDebugLog({ enabled: true, env }).write({ event: "request" });
    assert.equal(statSync(debugLogPath(env)).mode & 0o777, 0o600);
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    // A log path that cannot be written: the folder's place holds a file.
    const blocked = { XDG_STATE_HOME: join(folder, "debug.log") };
    assert.doesNotThrow(() => createDebugLog({ enabled: true, env: blocked }).write({ event: "request" }));
});

test("past the size cap the file is moved to debug.log.1, replacing an older one, and a new file starts", (t) => {
    const { env, folder } = state(t);
    const file = debugLogPath(env);
    const entry = (n: number) => ({ event: "request", n, pad: "x".repeat(40) });
    // Every line is the same length, so the cap can be set to fall after the fourth.
    createDebugLog({ enabled: true, env }).write(entry(0));
    const one = statSync(file).size;
    rmSync(file);
    const log = createDebugLog({ enabled: true, env, maxBytes: one * 4 - 5, now: () => new Date(0) });
    for (let n = 0; n < 4; n++) log.write(entry(n));
    assert.equal(existsSync(`${file}.1`), false, "under the cap nothing moves");
    // The old rotated file is replaced, not kept.
    writeFileSync(`${file}.1`, "old\n");
    log.write(entry(4));
    assert.deepEqual(
        readFileSync(`${file}.1`, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).n),
        [0, 1, 2, 3],
    );
    assert.deepEqual(
        lines(env).map((line) => line.n),
        [4],
    );
    assert.equal(statSync(`${file}.1`).mode & 0o777, 0o600);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(folder.length > 0);
});

/** Loads the whole extension against a fake catalog, fires session_start and lets the background discovery finish. */
async function startExtension(env: NodeJS.ProcessEnv, dir: string): Promise<void> {
    const { jigBedrock } = await import("../src/index.ts");
    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const pi = {
        on: (name: string, hook: (...args: unknown[]) => unknown) =>
            hooks.set(name, [...(hooks.get(name) ?? []), hook]),
        registerProvider() {},
        registerCommand() {},
        events: { emit() {} },
        setModel: () => false,
    };
    await (
        jigBedrock({
            env,
            listProfiles: async () => ["work"],
            catalog: { load: () => undefined, refresh: async () => "ok" },
        }) as never as (pi: unknown) => Promise<void>
    )(pi);
    const ctx = {
        hasUI: false,
        mode: "print",
        ui: { notify() {}, setStatus() {} },
        sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionDir: () => dir },
    };
    for (const hook of hooks.get("session_start") ?? []) await hook({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
}

test("the extension writes a discovery line with JIG_BEDROCK_DEBUG=1, and nothing without it", async (t) => {
    const { env } = state(t);
    const base = { ...env, PI_CODING_AGENT_DIR: join(env.HOME as string, "agent"), JIG_BEDROCK_PROFILE: "work" };
    await startExtension(base, env.HOME as string);
    assert.equal(existsSync(debugLogPath(env)), false, "off: no log file");
    await startExtension({ ...base, JIG_BEDROCK_DEBUG: "1" }, env.HOME as string);
    const [line] = lines(env);
    assert.equal(line?.event, "discovery");
    assert.deepEqual(line?.regions, ["us-east-1"]);
});

test("the debug setting in bedrock.json turns the log on", async (t) => {
    const { env } = state(t);
    const agent = join(env.HOME as string, "agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "bedrock.json"), JSON.stringify({ debug: true, profile: "work" }));
    await startExtension({ ...env, PI_CODING_AGENT_DIR: agent }, env.HOME as string);
    assert.equal(lines(env)[0]?.event, "discovery");
});
