/* biome-ignore-all lint/style/noNonNullAssertion: test assertions */
// Every failure the doctor must name in plain words, with stubbed AWS answers so no call leaves the machine.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    });
    const notices: string[] = [];
    await result.bedrock("doctor", {
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
    const text = await doctor(t, { aws: [{ ok: false, text: "Inference profiles: access denied while listing" }] });
    assert.match(text, /access denied while listing/);
    assert.match(text, /Next: \/bedrock refresh/);
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
    const file = join(root, "bedrock.json");
    writeFileSync(file, "{ broken");
    const notice: string[] = [];
    const handler = registerBrokenCommands({ registerCommand() {} } as never, {
        file,
        error: `${file} is not valid JSON; fix it or remove it.`,
        env: { HOME: root, PI_CODING_AGENT_DIR: root },
    });
    await handler("doctor", {
        hasUI: true,
        mode: "rpc",
        ui: { notify: (text: string) => notice.push(text) },
    } as never);
    assert.match(notice[0]!, /1 problem/);
    assert.match(notice[0]!, /not valid J/);
});

test("an AWS CLI version timeout is not a problem and never says install", async (t) => {
    const text = await doctor(t, { check: { ...ready, aws: { status: "timeout" as never } } });
    assert.match(text, /– AWS CLI: could not check/);
    assert.doesNotMatch(text, /install AWS CLI|✗ AWS CLI/);
});
