// The per-model table for the Messages route. Bedrock's error when thinking is off on Sonnet 5.5 is the fixture:
//   400 "To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}"
// The table stays as narrow as the real run: only Claude 5.5 is adaptive, and only Sonnet 5.5 gets between_tools.
import assert from "node:assert/strict";
import test from "node:test";
import {
    isAnthropicModel,
    needsBetweenTools,
    noThinkingOff,
    rewriteThinkingOff,
    usesAdaptiveThinking,
} from "../src/messages.ts";

test("only Claude profiles are on the Anthropic Messages route", () => {
    for (const id of [
        "anthropic.claude-sonnet-5-5",
        "us.anthropic.claude-opus-5-5",
        "global.anthropic.claude-haiku-5-5",
    ])
        assert.equal(isAnthropicModel(id), true, id);
    for (const id of ["amazon.nova-pro-v1:0", "global.openai.gpt-6-astra", "deepseek.v3-v1:0", "mistral.pixtral"])
        assert.equal(isAnthropicModel(id), false, id);
});

test("adaptive thinking follows Pi's own model list; older Claude keeps budget thinking", () => {
    for (const id of [
        "anthropic.claude-sonnet-5-5",
        "us.anthropic.claude-opus-5-5",
        "eu.anthropic.claude-haiku-5-5",
        "us.anthropic.claude-opus-4-8",
        "anthropic.claude-opus-4-6",
        "anthropic.claude-sonnet-4-6",
        "anthropic.claude-sonnet-5",
        "global.anthropic.claude-fable-5-2",
    ])
        assert.equal(usesAdaptiveThinking(id), true, id);
    for (const id of [
        "anthropic.claude-sonnet-4-5-20250929-v1:0",
        "anthropic.claude-haiku-4-5",
        "amazon.nova-pro-v1:0",
    ])
        assert.equal(usesAdaptiveThinking(id), false, id);
});

test("between_tools is Sonnet 5.5 only; Opus has no off, and Haiku keeps Pi's shape", () => {
    assert.equal(needsBetweenTools("anthropic.claude-sonnet-5-5"), true);
    assert.equal(needsBetweenTools("us.anthropic.claude-sonnet-5-5"), true);
    assert.equal(needsBetweenTools("anthropic.claude-opus-5-5"), false);
    assert.equal(needsBetweenTools("anthropic.claude-haiku-5-5"), false);
    assert.equal(needsBetweenTools("anthropic.claude-sonnet-4-5"), false);
});

test("rewrites only thinking-off on Sonnet 5.5, and leaves everything else alone", () => {
    const disabled = { thinking: { type: "disabled" }, max_tokens: 10 };
    assert.deepEqual(rewriteThinkingOff(disabled, "anthropic.claude-sonnet-5-5"), {
        thinking: { type: "between_tools" },
        max_tokens: 10,
    });
    assert.equal(rewriteThinkingOff(disabled, "anthropic.claude-opus-5-5"), disabled);
    assert.equal(rewriteThinkingOff(disabled, "anthropic.claude-sonnet-4-5"), disabled);
    const enabled = { thinking: { type: "enabled", budget_tokens: 1024 } };
    assert.equal(rewriteThinkingOff(enabled, "anthropic.claude-sonnet-5-5"), enabled);
    assert.equal(rewriteThinkingOff({}, "anthropic.claude-sonnet-5-5").thinking, undefined);
});

test("Opus 5.5 has no thinking-off; Sonnet and Haiku do", () => {
    assert.equal(noThinkingOff("anthropic.claude-opus-5-5"), true);
    assert.equal(noThinkingOff("us.anthropic.claude-opus-5-5"), true);
    for (const id of [
        "anthropic.claude-sonnet-5-5",
        "anthropic.claude-haiku-5-5",
        "anthropic.claude-sonnet-4-5",
        "amazon.nova-pro-v1:0",
    ])
        assert.equal(noThinkingOff(id), false, id);
});
