import assert from "node:assert/strict";
import test from "node:test";
import { noticeFor, withSsoRecovery } from "../src/sso.ts";
import { hostImport } from "./support/pi-host.ts";

const ai = await hostImport("@earendil-works/pi-ai");
const make = ai.createAssistantMessageEventStream;
const model: any = {
    provider: "jig-bedrock",
    api: "bedrock-converse-stream",
    id: "fixture",
    name: "Fixture",
    input: ["text"],
    type: "chat",
    contextWindow: 10000,
};
const context: any = { messages: [{ role: "user", content: "fixture", timestamp: 1 }] };
const message = (overrides: any = {}) => ({
    role: "assistant",
    content: [],
    ...model,
    model: model.id,
    stopReason: "error",
    timestamp: 1,
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    errorMessage: "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
    ...overrides,
});
const failed = (overrides: any = {}) => ({ type: "error", reason: "error", error: message(overrides) });
const done = () => ({
    type: "done",
    reason: "stop",
    message: message({ stopReason: "stop", errorMessage: undefined }),
});
function events(...items: any[]) {
    const stream = make();
    for (const item of items) stream.push(item);
    return stream;
}
async function collect(stream: any): Promise<any[]> {
    const output = [];
    for await (const event of stream) output.push(event);
    return output;
}
const options = { env: { AWS_PROFILE: "fixture-profile" } };

test("expired SSO recovers the exact profile and request once without replaying payload hooks", async () => {
    const profiles: string[] = [],
        notices: string[] = [],
        seen: any[] = [];
    let attempts = 0,
        hooks = 0;
    const native: any = (_model: any, transcript: any, opts: any) => {
        assert.equal(transcript, context);
        const stream = make();
        void (async () => {
            seen.push(await opts.onPayload({ fixture: true }, model));
            stream.push(++attempts === 1 ? failed() : done());
        })();
        return stream;
    };
    const wrapped = withSsoRecovery(
        native,
        make,
        async (profile) => {
            profiles.push(profile);
        },
        (text) => notices.push(text),
    );
    const result = await collect(
        wrapped(model, context, {
            ...options,
            onPayload: () => {
                hooks++;
                return { screened: true };
            },
        }),
    );
    assert.equal(attempts, 2);
    assert.equal(hooks, 1);
    assert.deepEqual(seen, [{ screened: true }, { screened: true }]);
    assert.deepEqual(profiles, ["fixture-profile"]);
    assert.deepEqual(
        result.map((event) => event.type),
        ["done"],
    );
    assert.equal(notices.length, 2);
});

test("healthy requests incur no auth helper or retry", async () => {
    let calls = 0;
    const wrapped = withSsoRecovery(
        () => {
            calls++;
            return events(done());
        },
        make,
        async () => assert.fail("unexpected login"),
        () => assert.fail("unexpected notice"),
    );
    assert.equal((await collect(wrapped(model, context, options)))[0].type, "done");
    assert.equal(calls, 1);
});

test("an incomplete or throwing provider terminates with a safe error instead of hanging", async () => {
    for (const native of [
        () => {
            const stream = make();
            stream.end();
            return stream;
        },
        () => {
            throw new Error("fixture-sensitive-failure");
        },
    ]) {
        const wrapped = withSsoRecovery(
            native,
            make,
            async () => assert.fail("unexpected login"),
            () => {},
        );
        const out = await collect(wrapped(model, context, options));
        assert.equal(out.length, 1);
        assert.equal(out[0].type, "error");
        assert.ok(!JSON.stringify(out).includes("fixture-sensitive"));
    }
});

test("non-auth errors, partial responses, billed requests and bearer auth never trigger login/replay", async () => {
    for (const scenario of [
        { error: failed({ errorMessage: "AccessDeniedException: model access denied" }) },
        { error: failed({ errorMessage: "TimeoutError: network unavailable" }) },
        { error: failed({ content: [{ type: "text", text: "partial" }] }) },
        { error: failed({ usage: { input: 1, output: 0, totalTokens: 1 } }) },
        { error: failed({ usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0.1 } } }) },
        { error: failed(), start: true },
        { error: failed(), response: true },
        { error: failed(), opts: { ...options, apiKey: "fixture-bearer" } },
        { error: failed(), opts: { env: { AWS_PROFILE: "--bad-profile" } } },
    ]) {
        let calls = 0,
            responses = 0;
        const native: any = (_m: any, _c: any, opts: any) => {
            calls++;
            const stream = make();
            void (async () => {
                if (scenario.response) await opts.onResponse({ status: 403, headers: {} }, model);
                if (scenario.start) stream.push({ type: "start", partial: message() });
                stream.push(scenario.error);
            })();
            return stream;
        };
        const wrapped = withSsoRecovery(
            native,
            make,
            async () => assert.fail("unexpected login"),
            () => {},
        );
        const out = await collect(
            wrapped(model, context, {
                ...options,
                ...scenario.opts,
                onResponse: async () => {
                    responses++;
                },
            }),
        );
        assert.equal(calls, 1);
        assert.equal(out.at(-1), scenario.error);
        assert.equal(responses, scenario.response ? 1 : 0);
    }
});

test("a second expiry is returned without a login loop", async () => {
    let calls = 0,
        logins = 0;
    const wrapped = withSsoRecovery(
        () => {
            calls++;
            return events(failed());
        },
        make,
        async () => {
            logins++;
        },
        () => {},
    );
    const out = await collect(wrapped(model, context, options));
    assert.equal(calls, 2);
    assert.equal(logins, 1);
    assert.equal(out.at(-1).type, "error");
});

test("the real Pi agent loop resumes after a completed tool without executing it again", async () => {
    const { Agent } = await hostImport("@earendil-works/pi-agent-core");
    let calls = 0,
        effects = 0,
        logins = 0;
    const transcripts: any[] = [];
    const wrapped = withSsoRecovery(
        (_m, transcript) => {
            transcripts.push(transcript);
            switch (++calls) {
                case 1:
                    return events({
                        type: "done",
                        reason: "toolUse",
                        message: message({
                            stopReason: "toolUse",
                            errorMessage: undefined,
                            content: [{ type: "toolCall", id: "once", name: "fixture_effect", arguments: {} }],
                        }),
                    });
                case 2:
                    return events(failed());
                default:
                    return events(done());
            }
        },
        make,
        async () => {
            logins++;
        },
        () => {},
    );
    const agent = new Agent({
        initialState: {
            model,
            tools: [
                {
                    name: "fixture_effect",
                    label: "Fixture",
                    description: "Count a local fixture effect",
                    parameters: { type: "object", properties: {} },
                    execute: async () => {
                        effects++;
                        return { content: [{ type: "text", text: "completed" }] };
                    },
                },
            ],
        },
        streamFn: (selected: any, transcript: any, opts: any) => wrapped(selected, transcript, { ...opts, ...options }),
    });
    await agent.prompt("fixture");
    assert.equal(calls, 3);
    assert.equal(effects, 1);
    assert.equal(logins, 1);
    assert.equal(transcripts[1], transcripts[2]);
    assert.equal(agent.state.messages.filter((entry: any) => entry.role === "user").length, 1);
    assert.equal(agent.state.messages.filter((entry: any) => entry.role === "toolResult").length, 1);
    assert.ok(!agent.state.messages.some((entry: any) => entry.stopReason === "error"));
});

test("login failure/cancellation never leak helper output and never replay a request", async () => {
    for (const cancel of [false, true]) {
        let calls = 0;
        const notices: string[] = [];
        const controller = new AbortController();
        const wrapped = withSsoRecovery(
            () => {
                calls++;
                return events(failed());
            },
            make,
            async () => {
                if (cancel) controller.abort();
                throw new Error("fixture-sensitive-helper-output");
            },
            (text) => notices.push(text),
        );
        const out = await collect(wrapped(model, context, { ...options, signal: controller.signal }));
        assert.equal(calls, 1);
        assert.ok(!JSON.stringify(out).includes("fixture-sensitive"));
        assert.equal(out[0].reason, cancel ? "aborted" : "error");
        assert.equal(notices.length, 1, "Only progress is notified; the stream owns the failure");
        assert.doesNotMatch(notices[0]!, /opened|Opening/);
    }
});

test("SSO notices go to the TUI, or to stderr where there is no notice area", () => {
    const shown: string[] = [],
        written: string[] = [];
    const ui = {
        notify: (text: string) => {
            shown.push(text);
        },
    };
    noticeFor({ mode: "tui", ui }, (line) => written.push(line))("Restoring AWS SSO (p)", "info");
    for (const mode of ["print", "json", "rpc", undefined])
        noticeFor({ mode, ui }, (line) => written.push(line))("Restoring AWS SSO (p)", "info");
    assert.deepEqual(shown, ["Restoring AWS SSO (p)"]);
    assert.equal(written.length, 4);
    assert.ok(written.every((line) => line === "jig-bedrock: Restoring AWS SSO (p)\n"));
});

test('"ask" with yes opens the shared recovery once', async () => {
    let calls = 0,
        logins = 0,
        asks = 0;
    const wrapped = withSsoRecovery(
        () => {
            calls++;
            return events(calls === 1 ? failed() : done());
        },
        make,
        async () => {
            logins++;
        },
        () => {},
        {
            mode: "ask",
            ask: async () => {
                asks++;
                return true;
            },
        },
    );
    const out = await collect(wrapped(model, context, options));
    assert.equal(asks, 1);
    assert.equal(logins, 1);
    assert.equal(calls, 2);
    assert.equal(out.at(-1)?.type, "done");
});

test('"ask" with no opens nothing and reports the sign-in hint', async () => {
    let calls = 0,
        logins = 0,
        asks = 0;
    const wrapped = withSsoRecovery(
        () => {
            calls++;
            return events(failed());
        },
        make,
        async () => {
            logins++;
        },
        () => {},
        {
            mode: "ask",
            ask: async () => {
                asks++;
                return false;
            },
        },
    );
    const out = await collect(wrapped(model, context, options));
    assert.equal(asks, 1);
    assert.equal(logins, 0);
    assert.equal(calls, 1);
    assert.match(out.at(-1)?.error?.errorMessage, /Run \/aws-login when you're ready\./);
});

test("two failing requests while the question is open ask once and recover once", async () => {
    let asks = 0,
        logins = 0;
    let answer!: (yes: boolean) => void;
    const question = new Promise<boolean>((resolve) => {
        answer = resolve;
    });
    const wrapped = withSsoRecovery(
        () => events(failed()),
        make,
        async () => {
            logins++;
        },
        () => {},
        {
            mode: "ask",
            ask: () => {
                asks++;
                return question;
            },
        },
    );
    const first = collect(wrapped(model, context, options));
    const second = collect(wrapped(model, context, options));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asks, 1);
    answer(false);
    const results = await Promise.all([first, second]);
    assert.equal(logins, 0);
    for (const out of results) assert.match(out.at(-1)?.error?.errorMessage, /Run \/aws-login/);
});

test('"false" reports the hint without asking or recovering', async () => {
    let calls = 0,
        asks = 0,
        logins = 0;
    const wrapped = withSsoRecovery(
        () => {
            calls++;
            return events(failed());
        },
        make,
        async () => {
            logins++;
        },
        () => {},
        { mode: false, ask: async () => (asks++, true) },
    );
    const out = await collect(wrapped(model, context, options));
    assert.equal(asks, 0);
    assert.equal(logins, 0);
    assert.equal(calls, 1);
    assert.match(out.at(-1)?.error?.errorMessage, /Run \/aws-login/);
});
