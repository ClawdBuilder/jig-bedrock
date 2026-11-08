import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSelection } from "../src/catalog.ts";

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
