import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRefused, refusedModels, rememberRefusal } from "../src/refusals.ts";

test("a refusal hides one model for seven days and then returns", () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-refused-"));
    try {
        const env = { HOME: dir, XDG_CACHE_HOME: join(dir, "cache") };
        const now = Date.UTC(2026, 10, 16);
        assert.equal(isRefused(env, "fixture", "arn:one", now), false);
        rememberRefusal(env, "fixture", "arn:one", "claude-opus-5", now);
        assert.equal(isRefused(env, "fixture", "arn:one", now + 6 * 86_400_000), true);
        assert.equal(isRefused(env, "fixture", "arn:one", now + 7 * 86_400_000), false);
        assert.equal(refusedModels(env, "fixture", now).length, 1);
        assert.equal(refusedModels(env, "other", now).length, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
