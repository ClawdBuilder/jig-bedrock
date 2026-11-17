import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveDiscoverySettings, saveProfileSetting } from "../src/settings-write.ts";

test("login under an active preset writes into the preset and leaves the top level alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-preset-login-"));
    try {
        writeFileSync(
            join(dir, "bedrock.json"),
            JSON.stringify({
                profile: "keys",
                regions: ["us-east-1"],
                presets: { work: { profile: "demo-sso", regions: ["us-west-2"] } },
                preset: "work",
            }),
        );
        const env = { HOME: dir, PI_CODING_AGENT_DIR: dir };
        assert.equal(saveProfileSetting(env, "keys", "work").ok, true);
        const result = saveDiscoverySettings(
            env,
            { mode: "explicit", regions: ["eu-west-1"], profiles: ["arn:test"] },
            "work",
        );
        assert.equal(result.written, true, result.error);
        const saved = JSON.parse(readFileSync(join(dir, "bedrock.json"), "utf8"));
        assert.deepEqual(saved.presets.work, {
            profile: "keys",
            discovery: "list",
            regions: ["eu-west-1"],
            profiles: ["arn:test"],
        });
        assert.equal(saved.profile, "keys");
        assert.deepEqual(saved.regions, ["us-east-1"]);
        assert.equal(saved.profiles, undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("login without an active preset still writes the top level", () => {
    const dir = mkdtempSync(join(tmpdir(), "bedrock-preset-login-"));
    try {
        writeFileSync(join(dir, "bedrock.json"), JSON.stringify({ profile: "keys", regions: ["us-east-1"] }));
        const env = { HOME: dir, PI_CODING_AGENT_DIR: dir };
        assert.equal(saveProfileSetting(env, "demo-sso").ok, true);
        assert.equal(saveDiscoverySettings(env, { mode: "system", regions: ["eu-west-1"] }).written, true);
        const saved = JSON.parse(readFileSync(join(dir, "bedrock.json"), "utf8"));
        assert.equal(saved.profile, "demo-sso");
        assert.deepEqual(saved.regions, ["eu-west-1"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
