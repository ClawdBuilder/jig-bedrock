import assert from "node:assert/strict";
import { test } from "node:test";
import { isOwnModel, resolveSelection } from "../src/catalog.ts";

const opus = {
    id: "claude-opus-5-5",
    arn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opus",
    aliases: ["claude-opus-5-5-team"],
};
const sonnet = {
    id: "claude-sonnet-5-5",
    arn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/sonnet",
    aliases: [],
};
const models = [opus, sonnet] as any[];

test("only this package's provider is its own; the built-in provider is not", () => {
    assert.equal(isOwnModel({ provider: "jig-bedrock" }), true);
    assert.equal(isOwnModel({ provider: "amazon-bedrock" }), false);
});

test("a saved selection resolves by id, alias, or the team profile ARN under either provider name", () => {
    assert.equal(resolveSelection(models, "jig-bedrock/claude-opus-5-5")?.id, "claude-opus-5-5");
    assert.equal(resolveSelection(models, "claude-opus-5-5-team")?.id, "claude-opus-5-5");
    assert.equal(resolveSelection(models, `amazon-bedrock/${opus.arn}`)?.id, "claude-opus-5-5");
    assert.equal(resolveSelection(models, sonnet.arn)?.id, "claude-sonnet-5-5");
});

test("an unknown ARN or id stays unresolved", () => {
    assert.equal(
        resolveSelection(
            models,
            "amazon-bedrock/arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/other",
        ),
        undefined,
    );
    assert.equal(resolveSelection(models, "claude-haiku-4-5"), undefined);
});

test("a 0.2.x ARN session moves to this package's short model", async () => {
    const { registerBedrockSelectionGuard } = await import("../src/catalog.ts");
    const hooks: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const selected: Array<{ provider: string; id: string }> = [];
    const target = { provider: "jig-bedrock", id: "claude-opus-5-5" };
    const pi = {
        on: (_name: string, hook: (event: unknown, ctx: unknown) => unknown) => hooks.push(hook),
        setModel: async (model: { provider: string; id: string }) => {
            selected.push(model);
            return true;
        },
    };
    const ctx = {
        model: { provider: "amazon-bedrock", id: opus.arn },
        sessionManager: { getBranch: () => [{ type: "model_change", provider: "amazon-bedrock", modelId: opus.arn }] },
        modelRegistry: { find: () => target },
        ui: { notify() {} },
    };
    registerBedrockSelectionGuard(pi as never, models, { agentDir: "/missing" });
    await hooks[0]?.({ type: "session_start", reason: "resume" }, ctx);
    assert.deepEqual(selected, [target]);
});

test("a built-in session with a plain model id is left alone", async () => {
    const { registerBedrockSelectionGuard } = await import("../src/catalog.ts");
    const hooks: Array<(event: unknown, ctx: unknown) => unknown> = [];
    let set = 0;
    const ctx = {
        model: { provider: "amazon-bedrock", id: "anthropic.claude-fable-5" },
        sessionManager: {
            getBranch: () => [
                { type: "model_change", provider: "amazon-bedrock", modelId: "anthropic.claude-fable-5" },
            ],
        },
        modelRegistry: { find: () => assert.fail("the built-in provider is not looked up here") },
        ui: { notify: () => assert.fail("no warning for a built-in session") },
    };
    registerBedrockSelectionGuard(
        {
            on: (_name: string, hook: (event: unknown, ctx: unknown) => unknown) => hooks.push(hook),
            setModel: async () => {
                set++;
                return true;
            },
        } as never,
        models,
        { agentDir: "/missing" },
    );
    await hooks[0]?.({ type: "session_start", reason: "resume" }, ctx);
    assert.equal(set, 0);
});
