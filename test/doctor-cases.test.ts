/* biome-ignore-all lint/style/noNonNullAssertion: test assertions */
// Every failure the doctor must name in plain words, with stubbed AWS answers so no call leaves the machine.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerBedrockCommands, registerBrokenCommands } from "../src/commands.ts";
import { SpendTracker } from "../src/spend.ts";

const base = {
    team: "fixture",
    profile: "fixture",
    regions: ["us-east-1"],
    monthlyBudgetUsd: undefined,
    ssoLoginCommand: [],
    signInAtStart: false,
    agentDir: "/tmp",
};
const ready = {
    node: { status: "ready" as const, version: "22.19.0" },
    aws: { status: "ready" as const, version: "2.27.0" },
    platform: "linux" as const,
};
async function doctor(
    t: { after(fn: () => void): void },
    options: {
        check?: typeof ready;
        last?: Record<string, unknown>;
        aws?: Array<{ ok: boolean; text: string }>;
        models?: unknown[];
        spendCommand?: string[];
        profile?: string;
        status?:
            | "ok"
            | "timeout"
            | "sso_expired"
            | "permission_denied"
            | "configuration"
            | "credentials"
            | "network"
            | "unavailable";
        call?:
            | { ok: true; route: string; ms: number; cacheRead: number; cacheWrite: number }
            | { ok: false; error: string };
        args?: string;
    } = {},
) {
    const root = mkdtempSync(join(tmpdir(), "bedrock-doctor-case-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = { HOME: root, PI_CODING_AGENT_DIR: root, XDG_STATE_HOME: root, LANG: "C.UTF-8" };
    const tracker = new SpendTracker({ ...base, spendCommand: options.spendCommand }, env, () =>
        Date.UTC(2026, 10, 15),
    );
    if (options.spendCommand) await tracker.refresh(true);
    const result = registerBedrockCommands({ registerCommand() {} } as never, {
        config: {
            ...base,
            profile: "profile" in options ? (options.profile as string | undefined) : base.profile,
            agentDir: root,
            spendCommand: options.spendCommand,
        },
        spend: tracker,
        catalog: { load: () => undefined, refresh: async () => "ok" },
        models: () => (options.models ?? []) as never,
        env,
        check: async () => (options.check ?? ready) as never,
        lastChoice: () => (options.last ?? { profile: "fixture", exists: true }) as never,
        unavailable: () => [],
        doctorAws: async () => options.aws ?? [],
        discoveryStatus: options.status === undefined ? undefined : () => options.status,
        doctorCall:
            options.call === undefined
                ? undefined
                : async () => {
                      if (!options.call.ok) throw new Error(options.call.error);
                      const { ok: _ok, ...value } = options.call;
                      return value;
                  },
    });
    const notices: string[] = [];
    await result.bedrock(options.args ?? "doctor", {
        hasUI: true,
        mode: "rpc",
        signal: new AbortController().signal,
        ui: { notify: (text: string) => notices.push(text) },
    } as never);
    return notices.join("\n");
}

test("no AWS CLI", async (t) => {
    const text = await doctor(t, { check: { ...ready, aws: { status: "missing" as never } } });
    assert.match(text, /✗ AWS CLI: not found/);
    assert.match(text, /Next: install AWS CLI v2/);
});
test("no profile chosen", async (t) => {
    const text = await doctor(t, { last: {}, profile: undefined });
    assert.match(text, /✗ AWS profile: none chosen/);
    assert.match(text, /Next: \/login/);
});
test("profile not in the AWS config", async (t) => {
    const text = await doctor(t, { last: { profile: "missing", exists: false } });
    assert.match(text, /not in ~\/\.aws\/config/);
});
test("sign-in expired", async (t) => {
    const text = await doctor(t, { aws: [{ ok: false, text: "AWS identity: sign-in expired" }] });
    assert.match(text, /sign-in expired/);
    assert.match(text, /Next: \/bedrock login/);
});
test("access denied while listing", async (t) => {
    const text = await doctor(t, {
        status: "permission_denied",
        aws: [{ ok: false, text: "Inference profiles: access denied while listing" }],
    });
    assert.match(text, /access denied while listing/);
    assert.match(text, /bedrock:ListInferenceProfiles/);
});
test("access denied on one profile", async (t) => {
    const text = await doctor(t, { aws: [{ ok: false, text: "One profile: access denied" }] });
    assert.match(text, /One inference profile: access denied/);
});
test("no profiles for the tag, and a region with none", async (t) => {
    const text = await doctor(t, { aws: [{ ok: false, text: "Inference profiles: none found for these settings" }] });
    assert.match(text, /none found for these settings/);
});
test("a failing spend command", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bedrock-doctor-spend-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bad = join(root, "bad.mjs");
    writeFileSync(bad, "process.exit(2)\n");
    const text = await doctor(t, { spendCommand: [process.execPath, bad] });
    assert.match(text, /Spend command: exit code 2/);
    assert.match(text, /Next: see docs\/spend-command\.md/);
});
test("invalid settings JSON is a doctor row, not a silent disable", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bedrock-doctor-json-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "x".repeat(140), "bedrock.json");
    mkdirSync(join(root, "x".repeat(140)), { recursive: true });
    writeFileSync(file, "{ broken");
    const notice: string[] = [];
    const handler = registerBrokenCommands({ registerCommand() {} } as never, {
        file,
        error: `${file} is not valid JSON; fix it or remove it.`,
        env: { HOME: root, PI_CODING_AGENT_DIR: root, LANG: "C.UTF-8", TERM: "xterm-256color" },
    });
    await handler("doctor", {
        hasUI: true,
        mode: "rpc",
        ui: { notify: (text: string) => notice.push(text) },
    } as never);
    assert.match(notice[0]!, /^Bedrock doctor\n✗ Settings file is not valid JSON\./);
    assert.match(notice[0]!, /1 problem\./);
    assert.match(notice[0]!, /– File: .*…/);
});

test("an AWS CLI version timeout is not a problem and never says install", async (t) => {
    const text = await doctor(t, { check: { ...ready, aws: { status: "timeout" as never } } });
    assert.match(text, /– AWS CLI: could not check/);
    assert.doesNotMatch(text, /install AWS CLI|✗ AWS CLI/);
});

test("plain doctor says no request was sent, and call gives its own verdict", async (t) => {
    const plain = await doctor(t);
    assert.doesNotMatch(plain, /Bedrock is ready/);
    assert.match(plain, /Setup looks right; no request was sent\. \/bedrock doctor call sends one\./);
    const bad = await doctor(t, { args: "doctor call", call: { ok: false, error: "request timed out" } });
    assert.doesNotMatch(bad, /Bedrock is ready/);
    assert.match(bad, /✗ Request: request timed out/);
    assert.match(bad, /Next: fix the request failure above, then \/bedrock doctor call/);
    const good = await doctor(t, {
        args: "doctor call",
        call: { ok: true, route: "Messages", ms: 900, cacheRead: 0, cacheWrite: 120 },
    });
    assert.match(good, /Bedrock is ready\./);
});

test("each discovery failure gets its own next step", async (t) => {
    const timeout = await doctor(t, { status: "timeout", aws: [{ ok: false, text: "Inference profiles: timed out" }] });
    assert.match(timeout, /timed out; check network access/);
    assert.doesNotMatch(timeout, /ListInferenceProfiles/);
    const expired = await doctor(t, {
        status: "sso_expired",
        aws: [{ ok: false, text: "Inference profiles: sign-in expired" }],
    });
    assert.match(expired, /\/bedrock login/);
    assert.doesNotMatch(expired, /ListInferenceProfiles/);
    const denied = await doctor(t, {
        status: "permission_denied",
        aws: [{ ok: false, text: "Inference profiles: access denied while listing" }],
    });
    assert.match(denied, /bedrock:ListInferenceProfiles/);
    const none = await doctor(t, { status: "ok", aws: [{ ok: false, text: "Inference profiles: no Claude models" }] });
    assert.match(none, /check regions and the tag or explicit list/);
    assert.doesNotMatch(none, /ListInferenceProfiles/);
});

test("every doctor block in troubleshooting.md is the block the code prints", async (t) => {
    const page = readFileSync(join(import.meta.dirname, "..", "docs", "troubleshooting.md"), "utf8");
    const block = (text: string): string => {
        const lines = text.split("\n");
        const first = lines.find((line) => line.startsWith("✗ "));
        const next = lines.find((line) => line.startsWith("Next: "));
        assert.ok(first, text);
        assert.ok(next, text);
        return `${first}\n${next}`;
    };
    const signIn = await doctor(t, { aws: [{ ok: false, text: "AWS identity: sign-in expired" }] });
    assert.ok(page.includes(block(signIn)), block(signIn));
    const denied = await doctor(t, {
        status: "permission_denied",
        aws: [{ ok: false, text: "Inference profiles: access denied while listing" }],
    });
    assert.ok(page.includes(block(denied)), block(denied));
    const none = await doctor(t, {
        status: "ok",
        aws: [{ ok: false, text: "Inference profiles: no Claude models in eu-north-1" }],
    });
    assert.ok(page.includes(block(none)), block(none));
});

test("a long doctor row is shown whole, not cut at 100 characters", async (t) => {
    const row = `Identity: ${"x".repeat(140)}`;
    const text = await doctor(t, { aws: [{ ok: true, text: row }] });
    assert.ok(text.includes(row), "the row was cut");
});

test("a Fable data-retention refusal gets the model-specific next step", async (t) => {
    const body =
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"data retention mode \'default\' is not available for this model"}}';
    const text = await doctor(t, { args: "doctor call", call: { ok: false, error: body } });
    assert.match(text, /Request: 400/);
    assert.match(text, /data retention mode/);
    assert.match(text, /needs an AWS account data-retention setting/);
    assert.match(text, /A Fable model is refused/);
});
