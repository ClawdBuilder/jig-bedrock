import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearRefusals, isRefusalError, isRefused, refusedModels, rememberRefusal } from "../src/refusals.ts";

const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/team-app";
const refusal = `403 AccessDeniedException: not authorized to perform bedrock:InvokeModelWithResponseStream on resource ${arn}`;

test("only the role refusal is remembered, and for seven days", () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-refused-"));
    try {
        const env = { HOME: dir, XDG_CACHE_HOME: join(dir, "cache") };
        const now = Date.UTC(2026, 10, 16);
        assert.equal(isRefusalError(refusal, arn), true);
        for (const other of [
            "429 ThrottlingException: too many requests",
            "403 token is expired or invalid",
            "500 InternalServerException",
            "400 ValidationException",
            "403 AccessDeniedException: not authorized to perform bedrock:InvokeModelWithResponseStream on resource another",
        ])
            assert.equal(isRefusalError(other, arn), false, other);
        assert.equal(isRefused(env, "fixture", "123456789012", arn, now), false);
        rememberRefusal(env, "fixture", "123456789012", arn, "claude-opus-5", now);
        assert.equal(isRefused(env, "fixture", "123456789012", arn, now + 6 * 86_400_000), true);
        assert.equal(isRefused(env, "fixture", "123456789012", arn, now + 7 * 86_400_000), false);
        assert.equal(isRefused(env, "other", "123456789012", arn, now), false);
        assert.equal(isRefused(env, "fixture", "999999999999", arn, now), false);
        assert.equal(refusedModels(env, "fixture", "123456789012", now).length, 1);
        assert.equal(clearRefusals(env, "fixture", "123456789012"), 1);
        assert.equal(refusedModels(env, "fixture", "123456789012", now).length, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
